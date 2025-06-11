import { NextResponse } from "next/server";
import {
  address,
  appendTransactionMessageInstruction,
  assertIsAddress,
  createNoopSigner,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction,
  assertIsTransactionMessageWithBlockhashLifetime,
  getBase64EncodedWireTransaction,
  prependTransactionMessageInstruction,
  type Address,
  type TransactionSigner,
  type Blockhash
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getInitializeInstruction,
  getDelegateStakeInstruction
} from "@/utils/solana/stake/stake-instructions";
import { createRpcConnection } from "@/utils/solana/rpc";
import {
  MAX_COMPUTE_UNIT_LIMIT,
  STAKE_PROGRAM,
  SYSVAR
} from "@/utils/constants";
import {
  getSetComputeUnitLimitInstruction,
} from "@solana-program/compute-budget";
import { getValidatorVoteAddress } from "@/utils/config";
import { STAKE_PROGRAM_ADDRESS } from "@solana-program/stake";

interface StakeMessageParams {
  authority: Address;
  authorityNoopSigner: TransactionSigner;
  newAccount: Address;
  newAccountNoopSigner: TransactionSigner;
  stakeLamports: number;
  blockhashObject: Readonly<{
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
  }>;
  computeUnitLimit: number;
  priorityFeeMicroLamports?: number;
}

function getStakeMessage({
  authority,
  authorityNoopSigner,
  newAccount,
  newAccountNoopSigner,
  stakeLamports,
  blockhashObject,
  computeUnitLimit,
}: StakeMessageParams) {
  console.log(stakeLamports);
  return pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(authority, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhashObject, msg),
    (msg) =>
      prependTransactionMessageInstruction(
        getSetComputeUnitLimitInstruction({ units: computeUnitLimit }),
        msg
      ),
    // (msg) =>
    //   prependTransactionMessageInstruction(
    //     getSetComputeUnitPriceInstruction({
    //       microLamports: priorityFeeMicroLamports
    //     }),
    //     msg
    //   ),
    (msg) =>
      appendTransactionMessageInstruction(
        getCreateAccountInstruction({
          payer: authorityNoopSigner,
          newAccount: newAccountNoopSigner,
          lamports: BigInt(stakeLamports),
          space: STAKE_PROGRAM.STAKE_ACCOUNT_SPACE,
          programAddress: STAKE_PROGRAM_ADDRESS
        }),
        msg
      ),
    // () => 
    //   appendTransactionMessageInstruction(
    //     getTransferSolInstruction({
    //       source: authorityNoopSigner,
    //       destination: newAccountNoopSigner.address,
    //       amount: 
    //     })
    //   ),
    (msg) =>
      appendTransactionMessageInstruction(
        getInitializeInstruction(
          {
            stake: newAccount,
            rentSysvar: SYSVAR.RENT_ADDRESS,
            authorized: {
              staker: authority,
              withdrawer: authority
            },
            lockup: STAKE_PROGRAM.DEFAULT_LOCKUP
          },
          { programAddress: STAKE_PROGRAM_ADDRESS }
        ),
        msg
      ),
    (msg) =>
      appendTransactionMessageInstruction(
        getDelegateStakeInstruction(
          {
            stake: newAccount,
            vote: getValidatorVoteAddress(),
            clockSysvar: SYSVAR.CLOCK_ADDRESS,
            stakeHistory: SYSVAR.STAKE_HISTORY_ADDRESS,
            unused: STAKE_PROGRAM.CONFIG_ADDRESS,
            stakeAuthority: authorityNoopSigner
          },
          { programAddress: STAKE_PROGRAM_ADDRESS }
        ),
        msg
      )
  );
}

export async function POST(request: Request) {
  try {
    const { stakeLamports, stakerAddress, newAccountAddress } =
      await request.json();

    if (!stakeLamports) {
      return NextResponse.json(
        { error: "Missing required parameter: stakeLamports" },
        { status: 400 }
      );
    }
    if (!stakerAddress) {
      return NextResponse.json(
        { error: "Missing required parameter: stakerAddress" },
        { status: 400 }
      );
    }

    const authority = address(stakerAddress);
    const newAccount = address(newAccountAddress);
    assertIsAddress(authority);
    assertIsAddress(newAccount);

    const rpc = createRpcConnection();

    const authorityNoopSigner = createNoopSigner(authority);
    const newAccountNoopSigner = createNoopSigner(newAccount);

    // const sampleMessage = getStakeMessage({
    //   authority,
    //   authorityNoopSigner,
    //   newAccount,
    //   newAccountNoopSigner,
    //   stakeLamports,
    //   blockhashObject: INVALID_BUT_SUFFICIENT_FOR_COMPILATION_BLOCKHASH,
    //   computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT
    // });

    // console.log(sampleMessage);
    // assertIsTransactionMessageWithBlockhashLifetime(sampleMessage);
    // const computeUnitEstimate =
    //   await getComputeUnitEstimateForTransactionMessageFactory({ rpc })(
    //     sampleMessage
    //   );
    // console.log("computeUnitEstimate", computeUnitEstimate);

    const { value: latestBlockhash } = await rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    const message = getStakeMessage({
      authority,
      authorityNoopSigner,
      newAccount,
      newAccountNoopSigner,
      stakeLamports,
      blockhashObject: latestBlockhash,
      computeUnitLimit: MAX_COMPUTE_UNIT_LIMIT
    });

    assertIsTransactionMessageWithBlockhashLifetime(message);

    const compiledTransaction = compileTransaction(message);
    const wireTransaction =
      getBase64EncodedWireTransaction(compiledTransaction);

    return NextResponse.json({
      wireTransaction
    });
  } catch (error) {
    console.error("Error generating stake transaction:", error);
    return NextResponse.json(
      { error: "Failed to generate stake transaction" },
      { status: 500 }
    );
  }
}
