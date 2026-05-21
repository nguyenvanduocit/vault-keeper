---
template: templates/spec-template.md
document_type: spec
title: Bad parser-backed blocks
owner: '@carol'
---

# Bad parser-backed blocks

## Diagram

```mermaid
graph TD
  Cart--Payment
```

## Behavior

```gherkin
Scenario: missing feature
  Given a shopper has items in their cart
```
