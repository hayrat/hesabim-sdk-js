# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub: **Security → Report a vulnerability** on this
repository (GitHub Security Advisories). Include the affected package and
version, a description of the issue, and steps to reproduce if you have them.

We aim to acknowledge a report within 3 working days and to keep you updated
until a fix is released.

## Supported versions

Only the latest published `0.x` release of `@hayrat/hesabim-core` and
`@hayrat/hesabim-vue` receives security fixes.

## Scope

This repository contains browser client code only. It holds no secrets: the
SDK is an OAuth **public client** (Authorization Code + PKCE) and never uses a
client secret. Never put a client secret into a browser application.
