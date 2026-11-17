import { actor } from "actors-poc";

export const Counter = actor({
  state: { count: 0 },

  actions: {
    increment: ({ state }, amount: number = 1) => {
      state.count += amount;
      return state.count;
    },

    get: ({ state }) => state.count,

    // Demonstrates rollback: the mutation is discarded because the action throws.
    incrementThenFail: ({ state }, amount: number = 1) => {
      state.count += amount;
      throw new Error("Simulated failure after mutating state");
    },
  },
});
