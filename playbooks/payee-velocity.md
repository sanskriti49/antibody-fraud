---
id: pb-payee-velocity
version: 1
title: New payee cash-out and transfer velocity
status: approved
trigger: fresh_payee, amount_spike
trigger: transfer_burst, new_payee
trigger: fresh_payee, transfer_burst
---
# New payee cash-out and transfer velocity

Synthetic guidance for the ContextCon fraud lab. Not operational advice.

## Typical sequence
- Small ordinary transfers in quick succession.
- A payee registered minutes before use.
- A transfer to that payee far above the historical mean.

## Investigation checklist
- Compare the amount with the historical transfer mean and count.
- Check the payee's age and whether other accounts paid it recently.
- Check whether the payee registration came with a timing shift.
- Review the earlier transfers in the burst for a familiar payee.

## Action guidance
- Step-up verification for the first transfer to a payee registered in the last 15 minutes.
- Block when amount spike, burst and fresh payee coincide, or a verified velocity pattern repeats.

## Benign explanations
- Paying several bills at once creates a burst without a cash-out.
- A planned large purchase to a new merchant. The amount alone is not proof.
