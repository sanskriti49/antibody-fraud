---
id: pb-credential-stuffing
version: 1
title: Credential stuffing and reset abuse
status: approved
trigger: login_pressure, new_device
trigger: reset_after_device_failures
trigger: login_pressure, impossible_travel
---
# Credential stuffing and reset abuse

Synthetic guidance for the ContextCon fraud lab. Not operational advice.

## Typical sequence
- Several failed sign-ins from one unfamiliar device or network within minutes.
- A password reset attempted from that same device.
- A successful sign-in with shifted timing, sometimes from far away.

## Investigation checklist
- Count failures on this device and network, and across other accounts on the network.
- Check whether the reset came from the device that produced the failures.
- Check travel distance and speed against the previous successful sign-in.
- Look for the same network in other accounts' recent failures.

## Action guidance
- Treat failed sign-ins as observations, never as enforcement on their own.
- Require verification on the reset when it follows failures on an unfamiliar device.
- Block access when the session repeats a verified credential-stuffing pattern.

## Benign explanations
- A customer who forgot a password on a new device. Failures usually come from a familiar network.
- Shared office networks produce failures across accounts without an attack.
