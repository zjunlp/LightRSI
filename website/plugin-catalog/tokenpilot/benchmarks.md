# TokenPilot Benchmarks

Benchmark tasks, runners, profiles, analysis, and result bundles now live in the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot). This page remains as a navigation entry in the LightRSI documentation.

## Scope

TokenPilot is evaluated on **PinchBench** and **Claw-Eval**, with isolated and continuous execution modes. The benchmark harness and its outputs are intentionally kept out of the LightRSI runtime repository so the platform can remain focused on reusable components and host integration.

## Reproduction

Use the [TokenPilot reproduction guide](https://github.com/Xubqpanda/TokenPilot/blob/main/README.md) for:

- environment setup and provider configuration
- benchmark data and task layout
- baseline and TokenPilot runner commands
- isolated and continuous profiles
- usage accounting, reports, and result bundles

Benchmark-specific entrypoints:

- [PinchBench](https://github.com/Xubqpanda/TokenPilot/tree/main/benchmarks/pinchbench)
- [Claw-Eval](https://github.com/Xubqpanda/TokenPilot/tree/main/benchmarks/claw-eval)

The experiment repository is the source of truth for current numbers. LightRSI documentation should describe the runtime behavior and adapter contract rather than duplicate benchmark tables.
