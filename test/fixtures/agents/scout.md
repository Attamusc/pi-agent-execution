---
name: scout
description: Fast codebase reconnaissance
tools: read, bash, write
deny-tools: claude
model: github-copilot/gpt-5.6-luna
thinking: low
skills: learn-codebase, researcher
spawning: false
auto-exit: true
system-prompt: append
cwd: /tmp/scout
---

# Scout Agent

Map the relevant code and report findings.
