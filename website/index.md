---
layout: home

hero:
  name: "LightRSI"
  text: "Runtime for Recursive Improvement in Long-Running Agents"
  tagline: Build, evaluate, and safely deploy improvement loops across agent hosts
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/what-is-lightrsi
    - theme: alt
      text: Quick Start
      link: /getting-started/quick-start
    - theme: alt
      text: View on GitHub
      link: https://github.com/zjunlp/LightRSI

features:
  - title: Cache-Efficient Context
    details: Stable-prefix rewriting, context reduction, and lifecycle-aware eviction keep long-running sessions manageable.
  - title: Multi-Host Support
    details: TokenPilot runs on OpenClaw, Codex CLI, and Claude Code through reusable host adapters; LightRSI also exposes a DeepSeek Harness compatibility adapter.
  - title: Built-in Observability
    details: Session reports, visual inspector dashboard, and doctor diagnostics help you understand exactly what's happening.
  - title: Modular Plugin Architecture
    details: Build agent capabilities once. The core runtime provides lifecycle management, configuration, and event routing.
---
