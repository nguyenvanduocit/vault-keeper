---
template: templates/spec-template.md
document_type: spec
title: Checkout behavior spec
owner: '@carol'
---

# Checkout behavior spec

## Diagram

```mermaid
graph TD
  Cart-->Payment
  Payment-->Confirmation
```

## Behavior

```gherkin
Feature: Checkout
  Scenario: successful card payment
    Given a shopper has items in their cart
    When they submit a valid card payment
    Then the order confirmation is shown
```
