# Security Policy

## Supported version

Security fixes are made on the latest `main` branch. This project is pre-1.0 and does not currently maintain older release lines.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not include cookies, access tokens, resumes, chat exports,
screenshots, phone numbers, or other personal data in a public issue.

Include the affected commit, a minimal fictional reproduction, expected impact, and any suggested mitigation. Reports that require
bypassing login, CAPTCHA, platform risk controls, or another person's account are outside the supported product boundary.

## Data boundary

Boss Watch stores job-search facts locally. The repository must never contain runtime databases, credentials, browser profiles,
real resumes, recruiting messages, or exported user data. External writes remain approval-gated and login/risk controls stay
human-operated.
