# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability
reporting: open this repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue.

Include the affected version, a description and, if you can, a test that shows
the problem against a mocked `fetch`. Never include a real API key or real
customer data in the report.

We aim to acknowledge reports within five business days.

## Supported versions

Only the latest published minor version receives fixes.

## Handling API keys

This library sends your key only as an `Authorization: Bearer` header to the
provider's base URL (or the `baseUrl` you set). It never logs the key and never
puts it in an error message. Keep keys in your platform's secret store.
