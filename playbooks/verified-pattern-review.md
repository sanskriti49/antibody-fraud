---
id: pb-verified-pattern-review
version: 1
title: Reviewing a block from a verified pattern
status: approved
trigger: verified_pattern_match
---
# Reviewing a block from a verified pattern

Synthetic guidance for the ContextCon fraud lab. Not operational advice.

## What happened
- The session repeated at least two ordered steps of an attack an analyst confirmed on another account.
- The verified-pattern policy blocked the event. No model made this decision.

## Investigation checklist
- Open the matched pattern. Check which steps repeated and the origin case.
- Compare the session's rules with the pattern's later steps and conditions.
- Check whether the customer has confirmed the activity out of band.

## Analyst actions
- Confirm fraud on this case to corroborate the pattern.
- If the customer is genuine, submit a legitimate correction with a rule the attack had and this session lacked.
- Revoke the pattern if the original confirmation was wrong.
