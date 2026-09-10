---
title: Calculator
description: Arithmetic, percentages, unit and currency conversion, and date and time maths, answered as you type.
---

![Calculator](/openray/screenshots/calculator.svg)

There is no calculator command to open. Type a question in root search and the answer appears
in a card above the results.

Press ↵ to copy the answer. ⌘↵ copies the raw unformatted value, and ⌘⇧↵ copies the whole
`question = answer` line.

Nothing appears unless what you typed actually parses, so an app name or a snippet keyword
never produces a stray calculator row.

## Arithmetic

```text
1024 * 8
(3 + 4) ^ 2
17 mod 5
sqrt(144) + ln(e)
```

Operators are `+ - * / ^ %`, with parentheses. Words work too: `plus`, `minus`, `times`, `x`,
`divided by`, `mod`, `power`. `pi` and `e` are constants, and a trailing `deg` converts
degrees to radians.

Functions available: `sqrt`, `cbrt`, `abs`, `round`, `floor`, `ceil`, `ln`, `log10`, `log2`,
`exp`, `sin`, `cos`, `tan`, `cot`, `sec`, `csc`, `asin`, `acos`, `atan`, `sinh`, `cosh`,
`tanh`, `asinh`, `acosh`, `atanh`.

Half-typed parentheses are closed for you, so the answer keeps updating while you type.

## Percentages

```text
15% of 240
20% off 85
8% on 50
15% tip on 62
```

`of` takes the percentage, `off` subtracts it, and `on` and `tip on` add it to the total. A
bare `52%` on its own just divides by a hundred.

## Unit conversion

```text
128 gb to mb
10ft in m
72f to c
5 miles in km
```

Split on either `in` or `to`. Covered categories are length, mass, temperature, data size,
area, volume and speed, with the usual aliases, so `ft`, `feet` and `foot` all work.

Three special targets go beyond plain units: `px at N ppi`, `to timespan`, and `in workdays`.

## Currency

```text
100 usd to eur
€50 in gbp
1.5k eur to jpy
```

Currency codes and symbols both work, in either order. Rates come from a public exchange-rate
service and are cached, refreshed when they are more than twelve hours old.

This is the one part of the calculator that uses the network. Everything else is computed
locally.

## Date and time

```text
time in 4 hours
days until 31 Mar
August 5 + 5
5pm ldn in sf
diff paris
```

Timezone phrases understand around forty city aliases mapped to real timezones, so `ldn`,
`sf` and `paris` resolve without you naming a zone. Cities outside that list simply do not
match, and no row appears.

## In snippets

`{calculator expression="..."}` evaluates an expression inside a snippet. Currency is the
exception there: the snippet path is given no rate table, so a currency conversion is left
unexpanded. See the [placeholder reference](/docs/features/snippets#placeholders).

## Related

- [Core concepts](/docs/getting-started/core-concepts) — how inline rows work
- [Translate](/docs/features/translate) — the other inline answer
