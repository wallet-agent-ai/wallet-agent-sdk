import {
  buildStakeManifest,
  buildUnstakeManifest,
  buildClaimManifest,
} from "../../builders/staking";

import type {
  StakeParams,
  UnstakeParams,
  ClaimParams,
  StakeResult,
} from "../../types";

export class GenericStakingAdapter {

  async stake(params: StakeParams): Promise<StakeResult> {
    this.validateStakeParams(params);
    return buildStakeManifest(params);
  }

  async unstake(params: UnstakeParams): Promise<StakeResult> {
    this.validateUnstakeParams(params);
    return buildUnstakeManifest(params);
  }

  async claim(params: ClaimParams): Promise<StakeResult> {
    this.validateClaimParams(params);
    return buildClaimManifest(params);
  }

  private validateStakeParams(params: StakeParams): void {
    if (!params.validatorAddress.startsWith("validator_")) {
      throw new Error(
        `validatorAddress inválido: debe empezar con 'validator_'. Recibido: ${params.validatorAddress}`
      );
    }
    const amount = parseFloat(params.amount);
    if (isNaN(amount) || amount < 1) {
      throw new Error(`amount mínimo para staking es 1 XRD. Recibido: ${params.amount}`);
    }
    if (!params.vaultAddress || !params.notarizerAddress) {
      throw new Error("vaultAddress y notarizerAddress son requeridos");
    }
    if (!params.badgeResourceAddress || !params.badgeLocalId) {
      throw new Error("badgeResourceAddress y badgeLocalId son requeridos");
    }
  }

  private validateUnstakeParams(params: UnstakeParams): void {
    if (!params.validatorAddress.startsWith("validator_")) {
      throw new Error(`validatorAddress inválido: ${params.validatorAddress}`);
    }
    if (!params.lsuResourceAddress.startsWith("resource_")) {
      throw new Error(`lsuResourceAddress inválido: ${params.lsuResourceAddress}`);
    }
    const amount = parseFloat(params.lsuAmount);
    if (isNaN(amount) || amount <= 0) {
      throw new Error(`lsuAmount inválido: ${params.lsuAmount}`);
    }
  }

  private validateClaimParams(params: ClaimParams): void {
    if (!params.validatorAddress.startsWith("validator_")) {
      throw new Error(`validatorAddress inválido: ${params.validatorAddress}`);
    }
    if (!params.claimNftResourceAddress.startsWith("resource_")) {
      throw new Error(`claimNftResourceAddress inválido: ${params.claimNftResourceAddress}`);
    }
    if (!params.claimNftIds || params.claimNftIds.length === 0) {
      throw new Error("claimNftIds no puede estar vacío");
    }
  }
}

export const genericStakingAdapter = new GenericStakingAdapter();
