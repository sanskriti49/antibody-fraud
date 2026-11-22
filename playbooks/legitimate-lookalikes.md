---
id: pb-legitimate-lookalikes
version: 1
title: Legitimate look-alikes and how to clear them
status: approved
trigger: new_device
trigger: shared_network
trigger: impossible_travel
---
# Legitimate look-alikes and how to clear them

Synthetic guidance for the ContextCon fraud lab. Not operational advice.

## Common look-alikes
- Account recovery on a new phone: new device, shifted typing, a reset and a modest payment to a new contact.
- Travel: a far-away sign-in on a familiar or new device with normal typing.
- Shared household or office: one device or network across several accounts with familiar payees.

## Investigation checklist
- Check whether the amount stays near the customer's usual range.
- Check whether the payee is already known to the customer.
- Ask the customer to confirm through an independent channel.
- If a verified pattern blocked the customer, open the pattern and compare it with the session's rules.

## Correcting memory
- Submit a legitimate correction naming a rule the attack had and this session lacked, such as amount_spike.
- Revoke the pattern only if it should never have been confirmed.
- Never correct by lowering thresholds for one customer.
