# Subagents

[Overview](overview.md) · [Routing](routing.md)

Automatic integration with [pi-subagents](https://www.npmjs.com/package/pi-subagents)
is disabled. Pi-subagents owns child model selection, role settings, explicit
models, workflow scripts and recovery.

pi8 does not change subagent call arguments, compute role models, probe child
credentials or use child results to update parent provider exclusions, spend
or tool-gap records. General work and context tool gates still apply to a
subagent call, as they apply to other tools.

`/router-agents` reports that the integration is disabled. It does not inspect
models, credentials or role settings.

The inactive implementation remains in `extensions/agents/`.
Tests cover argument preservation and the absence of parent routing effects.
Subagent model selection is outside the unified cutover scope. Use the installed
Pi-subagents documentation for role settings, workflow syntax and isolation.

The parent must follow the user's delegation instructions. This extension does
not grant permission to start a child.
