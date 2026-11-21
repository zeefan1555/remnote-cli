export type OperationStepState = 'started' | 'applied' | 'verified' | 'unknown';
export type OperationFailureStatus = 'partial' | 'unknown' | 'incomplete' | 'conflict';

interface OperationKernelConfig {
  canWrite: () => boolean;
  persist: () => Promise<void>;
  getStep: (step: string) => OperationStepState | undefined;
  setStep: (step: string, state: OperationStepState) => void;
  listSteps: () => Array<[string, OperationStepState]>;
  beforeMutation?: () => Promise<void>;
  now?: () => number;
  deadline?: number;
}

/** Shared precondition, durable step transition and unknown-outcome policy. */
export class OperationKernel {
  constructor(private readonly config: OperationKernelConfig) {}

  async assertCanMutate(): Promise<void> {
    await this.config.beforeMutation?.();
    if ((this.config.now?.() ?? Date.now()) > (this.config.deadline ?? Number.MAX_SAFE_INTEGER))
      throw new Error('Mutation deadline exhausted');
    if (!this.config.canWrite()) throw new Error('Write operations are disabled');
  }

  async checkpoint(step: string, state: OperationStepState): Promise<void> {
    this.config.setStep(step, state);
    await this.config.persist();
  }

  async markUnknown(step: string): Promise<void> {
    this.config.setStep(step, 'unknown');
    try {
      await this.config.persist();
    } catch {
      // A persisted started state is still enough to block automatic replay.
    }
  }

  async runStep<T>(
    step: string,
    mutate: () => Promise<T>,
    verify: (value: T) => Promise<void>
  ): Promise<T | undefined> {
    if (this.config.getStep(step) === 'verified') return undefined;
    await this.assertCanMutate();
    await this.checkpoint(step, 'started');
    try {
      const value = await mutate();
      await verify(value);
      await this.assertCanMutate();
      await this.checkpoint(step, 'verified');
      return value;
    } catch (error) {
      await this.markUnknown(step);
      throw error;
    }
  }

  failureStatus(options: { conflict?: boolean; mutated?: boolean }): OperationFailureStatus {
    if (options.conflict) return 'conflict';
    const states = this.config.listSteps().map(([, state]) => state);
    if (states.includes('started') || states.includes('unknown')) return 'unknown';
    return options.mutated ? 'partial' : 'incomplete';
  }
}
