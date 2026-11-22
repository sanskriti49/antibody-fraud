---
id: pb-coordinated-ring
version: 1
title: Coordinated accounts sharing infrastructure
status: approved
trigger: shared_device, shared_network, new_payee
trigger: shared_device, behaviour_shift
---
# Coordinated accounts sharing infrastructure

Synthetic guidance for the ContextCon fraud lab. Not operational advice.

## Typical sequence
- Several accounts sign in from one device or network within a day.
- They pay the same new payee.
- A target account with shifted timing joins and sends a large transfer.

## Investigation checklist
- Open the graph paths and list every account linked through device, network or payee.
- Check whether linked accounts were recently challenged or confirmed as fraud.
- Compare payee overlap across the linked accounts.
- Separate a shared household or office from a ring. A ring also shares new payees and shifted timing.

## Action guidance
- Require verification for transfers to a payee shared by linked accounts.
- Block when the session repeats a verified coordinated pattern.

## Benign explanations
- Households share a device. Offices share a network. Neither pays a new common payee in a burst.
