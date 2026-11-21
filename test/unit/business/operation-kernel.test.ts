import { describe, expect, it, vi } from 'vitest';
import {
  OperationKernel,
  type OperationStepState,
} from '../../../src/business/operation-kernel.js';

function kernel(options: { writable?: boolean; deadline?: number; now?: number } = {}) {
  const steps = new Map<string, OperationStepState>();
  const persist = vi.fn(async () => {});
  const beforeMutation = vi.fn(async () => {});
  const instance = new OperationKernel({
    canWrite: () => options.writable !== false,
    persist,
    getStep: (step) => steps.get(step),
    setStep: (step, state) => steps.set(step, state),
    listSteps: () => [...steps],
    beforeMutation,
    now: () => options.now ?? 0,
    deadline: options.deadline,
  });
  return { instance, steps, persist, beforeMutation };
}

describe('shared mutation kernel', () => {
  it('persists started and verified transitions in order', async () => {
    const f = kernel();
    const mutate = vi.fn(async () => 'created');
    const verify = vi.fn(async () => {});
    await expect(f.instance.runStep('create:one', mutate, verify)).resolves.toBe('created');
    expect(f.steps.get('create:one')).toBe('verified');
    expect(f.beforeMutation).toHaveBeenCalledTimes(2);
    expect(f.persist).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalledBefore(verify as never);
  });

  it('marks a failed or unknown mutation and never leaves it verified', async () => {
    const f = kernel();
    await expect(
      f.instance.runStep(
        'patch:one',
        async () => {
          throw new Error('connection lost');
        },
        async () => {}
      )
    ).rejects.toThrow('connection lost');
    expect(f.steps.get('patch:one')).toBe('unknown');
    expect(f.persist).toHaveBeenLastCalledWith();
  });

  it('enforces write permission and deadline before a mutation', async () => {
    await expect(kernel({ writable: false }).instance.assertCanMutate()).rejects.toThrow(
      'disabled'
    );
    await expect(kernel({ deadline: 1, now: 2 }).instance.assertCanMutate()).rejects.toThrow(
      'deadline'
    );
  });

  it('classifies stale and partial journals without treating them as verified', () => {
    const f = kernel();
    f.steps.set('old', 'started');
    expect(f.instance.failureStatus({ mutated: true })).toBe('unknown');
    f.steps.set('old', 'verified');
    expect(f.instance.failureStatus({ mutated: true })).toBe('partial');
    expect(f.instance.failureStatus({ conflict: true })).toBe('conflict');
    f.steps.clear();
    expect(f.instance.failureStatus({})).toBe('incomplete');
  });
});
