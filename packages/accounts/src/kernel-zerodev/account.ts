import type { Address } from "abitype";
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  type FallbackTransport,
  hashMessage,
  type Hex,
  toBytes,
  type Transport,
  pad,
  toHex,
} from "viem";
import { parseAbiParameters } from "abitype";
import { KernelBaseValidator, ValidatorMode } from "./validator/base.js";
import { KernelAccountAbi } from "./abis/KernelAccountAbi.js";
import { KernelFactoryAbi } from "./abis/KernelFactoryAbi.js";
import {
  type BaseSmartAccountParams,
  BaseSmartContractAccount,
  type SmartAccountSigner,
  type BatchUserOperationCallData,
  type UserOperationRequest,
  defineReadOnly,
  getChain,
} from "@alchemy/aa-core";
import {
  BUNDLER_URL,
  ENTRYPOINT_ADDRESS,
  KERNEL_FACTORY_ADDRESS,
  KERNEL_IMPL_ADDRESS,
  MULTISEND_ADDR,
} from "./constants.js";
import { encodeMultiSend } from "./utils.js";
import { MultiSendAbi } from "./abis/MultiSendAbi.js";
import { polygonMumbai } from "viem/chains";
import { getChainId } from "./api/index.js";
import { createZeroDevPublicErc4337Client } from "./client/create-client.js";
import type { PaymasterAndBundlerProviders } from "./paymaster/types.js";
import type { KillSwitchValidator } from "./validator/kill-switch-validator.js";

export interface KernelSmartAccountParams<
  TTransport extends Transport | FallbackTransport = Transport
> extends Partial<BaseSmartAccountParams<TTransport>> {
  projectId: string;
  owner: SmartAccountSigner;
  factoryAddress?: Address;
  index?: bigint;
  validator?: KernelBaseValidator;
  bundlerProvider?: PaymasterAndBundlerProviders;
}

export function isKernelAccount(
  account: any
): account is KernelSmartContractAccount {
  return account && account.connectValidator !== undefined;
}

export class KernelSmartContractAccount<
  TTransport extends Transport | FallbackTransport = Transport
> extends BaseSmartContractAccount<TTransport> {
  private owner: SmartAccountSigner;
  private readonly factoryAddress: Address;
  private readonly index: bigint;
  validator?: KernelBaseValidator;

  constructor(params: KernelSmartAccountParams) {
    super({
      ...params,
      entryPointAddress: params.entryPointAddress ?? ENTRYPOINT_ADDRESS,
      chain: params.chain ?? polygonMumbai,
      rpcClient: params.rpcClient ?? BUNDLER_URL,
    });
    this.index = params.index ?? 0n;
    this.owner = params.owner;
    this.factoryAddress = params.factoryAddress ?? KERNEL_FACTORY_ADDRESS;
    this.validator = params.validator;
  }

  public static async init(
    params: KernelSmartAccountParams
  ): Promise<KernelSmartContractAccount> {
    const chainId = await getChainId(params.projectId);
    if (!chainId) {
      throw new Error("ChainId not found");
    }
    const chain = getChain(chainId);
    const rpcClient =
      typeof params.rpcClient === "string"
        ? createZeroDevPublicErc4337Client({
            chain,
            rpcUrl: params.rpcClient ?? BUNDLER_URL,
            projectId: params.projectId,
            bundlerProvider: params.bundlerProvider,
          })
        : params.rpcClient;
    const instance = new KernelSmartContractAccount({
      ...params,
      chain,
      rpcClient,
    });
    return instance;
  }

  connectValidator(validator: KernelBaseValidator): this {
    defineReadOnly(this, "validator", validator);
    return this;
  }

  getValidator(): KernelBaseValidator {
    if (!this.validator) {
      throw new Error("Validator not connected");
    }
    return this.validator;
  }

  getDummySignature(): Hex {
    return "0x00000000870fe151d548a1c527c3804866fab30abf28ed17b79d5fc5149f19ca0819fefc3c57f3da4fdf9b10fab3f2f3dca536467ae44943b9dbb8433efe7760ddd72aaa1c";
  }

  async getDynamicDummySignature(
    kernelAccountAddress: Address,
    calldata: Hex
  ): Promise<Hex> {
    if (!this.validator) {
      throw new Error("Validator not connected");
    }

    const dummyECDSASig =
      "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";
    const validatorMode = await this.validator.resolveValidatorMode(
      kernelAccountAddress,
      calldata
    );
    if (validatorMode === ValidatorMode.enable) {
      const enableData = await this.validator.getEnableData();
      const enableDataLength = enableData.length / 2 - 1;
      const enableSigLength = 65;
      const staticDummySig = concatHex([
        "0x000000000000000000000000",
        this.validator.getAddress(),
        "0x53dd285022D1512635823952d109dB39467a457E",
      ]);
      const pausedUntil = await (
        this.validator as KillSwitchValidator
      ).getPausedUntil();

      return concatHex([
        ValidatorMode.enable,
        staticDummySig,
        pad(toHex(enableDataLength), { size: 32 }),
        enableData,
        pad(toHex(enableSigLength), { size: 32 }),
        dummyECDSASig,
        pad(toHex(pausedUntil), { size: 6 }),
        dummyECDSASig,
      ]);
    }
    return concatHex([validatorMode, dummyECDSASig]);
  }

  async encodeExecute(target: Hex, value: bigint, data: Hex): Promise<Hex> {
    if (!this.validator) {
      throw new Error("Validator not connected");
    }
    if (target.toLowerCase() === this.accountAddress?.toLowerCase()) {
      return data;
    } else {
      return this.encodeExecuteAction(target, value, data, 0);
    }
  }

  async encodeBatchExecute(
    _txs: BatchUserOperationCallData
  ): Promise<`0x${string}`> {
    const multiSendCalldata = encodeFunctionData({
      abi: MultiSendAbi,
      functionName: "multiSend",
      args: [encodeMultiSend(_txs)],
    });
    return await this.encodeExecuteDelegate(
      MULTISEND_ADDR,
      BigInt(0),
      multiSendCalldata
    );
  }

  async encodeExecuteDelegate(
    target: Hex,
    value: bigint,
    data: Hex
  ): Promise<Hex> {
    return this.encodeExecuteAction(target, value, data, 1);
  }

  async signWithEip6492(msg: string | Uint8Array): Promise<Hex> {
    try {
      const formattedMessage = typeof msg === "string" ? toBytes(msg) : msg;
      let sig = await this.owner.signMessage(
        toBytes(hashMessage({ raw: formattedMessage }))
      );
      // If the account is undeployed, use ERC-6492
      if (!(await this.isAccountDeployed())) {
        sig = (encodeAbiParameters(
          parseAbiParameters("address, bytes, bytes"),
          [this.factoryAddress, await this.getFactoryInitCode(), sig]
        ) +
          "6492649264926492649264926492649264926492649264926492649264926492") as Hex; // magic suffix
      }

      return sig;
    } catch (err: any) {
      console.error("Got Error - ", err.message);
      throw new Error("Message Signing with EIP6492 failed");
    }
  }

  async signMessage(msg: Uint8Array | string): Promise<Hex> {
    if (!this.validator) {
      throw new Error("Validator not connected");
    }
    const formattedMessage = typeof msg === "string" ? toBytes(msg) : msg;
    return await this.validator.signMessage(formattedMessage);
  }

  signUserOp(userOp: UserOperationRequest): Promise<Hex> {
    if (!this.validator) {
      throw new Error("Validator not connected");
    }
    return this.validator.signUserOp(userOp);
  }

  protected encodeExecuteAction(
    target: Hex,
    value: bigint,
    data: Hex,
    code: number
  ): Hex {
    return encodeFunctionData({
      abi: KernelAccountAbi,
      functionName: "execute",
      args: [target, value, data, code],
    });
  }
  protected async getAccountInitCode(): Promise<Hex> {
    return concatHex([this.factoryAddress, await this.getFactoryInitCode()]);
  }

  protected async getFactoryInitCode(): Promise<Hex> {
    if (!this.validator) {
      throw new Error("Validator not connected");
    }
    try {
      return encodeFunctionData({
        abi: KernelFactoryAbi,
        functionName: "createAccount",
        args: [
          KERNEL_IMPL_ADDRESS,
          encodeFunctionData({
            abi: KernelAccountAbi,
            functionName: "initialize",
            args: [
              this.validator.getAddress(),
              await this.validator.getEnableData(),
            ],
          }),
          this.index,
        ],
      });
    } catch (err: any) {
      console.error("err occurred:", err.message);
      throw new Error("Factory Code generation failed");
    }
  }
}
