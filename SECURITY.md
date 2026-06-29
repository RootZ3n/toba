# Security and Limitations

Toba is a local-first career-change command center. It generates artifacts,
scaffolding, and starter files. It is not a sandbox, DLP product, or security
certification.

## Lab-Use Local API

Toba does not implement built-in HTTP authorization. The API and UI are
intended for lab use on a trusted local machine and do not require
`Authorization: Bearer` headers.

## Local API Binding

The API binds to `127.0.0.1` by default. If you set `TOBA_HOST=0.0.0.0`,
put Toba behind your own authentication, authorization, and network access
controls before letting untrusted clients reach it.

## SQLite Database

Toba stores career data, campaign state, resume drafts, and lane management
in a local SQLite database. The database file should be treated as sensitive
— it contains personal career information, job application history, and
AI-generated content.

## Provider API Keys

Toba calls LLM providers for artifact generation and career coaching. API
keys are loaded from environment variables. If `.env` is in `.gitignore`,
keys stay local. Never commit real API keys to version control.

## Generated Artifacts

Toba generates files (resumes, configs, starter code) based on user input
and AI output. Review all generated artifacts before using them in
production or submitting them externally.

## State Directory Safety

Toba stores campaign data, receipts, and generated artifacts under its
data directory. Do not point that setting at an important directory.
Cleanup policies may remove temporary files.
