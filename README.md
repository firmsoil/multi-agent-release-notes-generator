# Multi-Agent AI Release Notes Generator

[![Release Notes](https://img.shields.io/badge/Release-Notes-blue.svg)](https://github.com/yourusername/repo)  
[![Python](https://img.shields.io/badge/Python-3.9+-blue.svg)](https://www.python.org/)  

> Generate clear, useful, and engaging release notes from GitHub commits, PRs, and diffs using a collaborative multi-agent AI system based on Google Claude / Google ADK.

---

## Table of Contents

- [About The Project](#about-the-project)  
- [Features](#features)  
- [Installation](#installation)  
- [Usage](#usage)  
- [Example Output](#example-output)  
- [Project Structure](#project-structure)  
- [Environment Variables](#environment-variables)  
- [Contributing](#contributing)  
- [License](#license)  
- [Acknowledgements](#acknowledgements)  

---

## About The Project

This project orchestrates a **multi-agent AI system** to automatically generate high-quality release notes for any GitHub repository. Each agent specializes in a specific task:

- **Commit Curator Agent**: Filters relevant, user-facing commits.  
- **Change Diff Analyzer Agent**: Extracts functional and technical improvements.  
- **PR Context Agent**: Captures intent and rationale behind changes.  
- **Release Notes Builder Agent**: Combines outputs into a cohesive, story-like release note.

The system produces release notes that are concise, engaging, and ready for end-users, rather than a dry list of commits.

---

## Features

- Filters commits to include only user-facing changes.  
- Analyzes diffs to detect bug fixes, performance improvements, and new features.  
- Extracts PR context to explain why changes were made.  
- Generates polished, story-like release notes.  
- Optional integration with Google Claude/Generative AI for high-quality summaries.  
- Supports local testing with sample files or live GitHub repository data.  
- Fully automatable using shell scripts or GitHub Actions.  

---

## Installation

1. **Clone the repository**  
```bash
git clone <your-repo-url>
cd release_notes_package
```

2. **Create a Python virtual environment**  
```bash
python3 -m venv .venv
source .venv/bin/activate
```

3. **Install dependencies**  
```bash
pip install -r requirements.txt
```

4. **Create `.env` file** in the project root:  
```text
GITHUB_TOKEN=your_github_personal_access_token
GENAI_API_KEY=your_genai_api_key
```

---

## Usage

### Local Testing with Sample Files

```bash
python release_notes_agents.py   --mode local   --commits samples/commits.txt   --diff samples/diff.txt   --prs samples/prs.txt   --version v0.1   --product MyProduct
```

### Generate Release Notes from GitHub Repo

```bash
./generate_release_notes.sh
```

- Automatically picks the penultimate and latest tags as the commit range.  
- Uses the latest tag as the release version.  
- Output is saved to `release_notes.txt`.  

---

## Example Output

### 1. Running the Script in Terminal

```
$ ./generate_release_notes.sh
Activating virtual environment...
Fetching commits from GitHub...
Fetching diffs and PRs...
Generating release notes for version v2.3.1...
Release notes saved to release_notes.txt
```

### 2. Generated Release Notes Preview

```
🚀 Introduced faster page loads with optimized caching
🐞 Fixed login edge-case that locked users out after timeout
✨ Added support for exporting reports directly to CSV
⚡ Improved search response time by 30%
```

### 3. Local Testing with Sample Files

```
$ python release_notes_agents.py --mode local --commits samples/commits.txt --diff samples/diff.txt --prs samples/prs.txt --version v0.1 --product MyProduct
Processing sample commits...
Processing sample diffs...
Processing sample PRs...
Release notes generated: samples/release_notes.txt

Sample output:
✨ Added CSV export feature
🐞 Fixed typo in login error message
⚡ Improved search efficiency
```

> These code blocks serve as visual examples of running the scripts and the release notes output. Replace them with real screenshots if desired.

---

## Project Structure

```
release_notes_package/
├── samples/                   # Example commits, diffs, and PRs for testing
├── release_notes_agents.py     # Main orchestration script
├── generate_release_notes.sh   # Shell script for automated GitHub runs
├── .env                        # Environment variables (GITHUB_TOKEN, GENAI_API_KEY)
├── requirements.txt            # Python dependencies
├── Dockerfile                  # Optional Docker build
└── README.md                   # Project documentation
```

---

## Environment Variables

| Variable         | Description                                   |
|-----------------|-----------------------------------------------|
| GITHUB_TOKEN     | GitHub personal access token for repo access |
| GENAI_API_KEY    | Google Claude / GADK API key (optional)      |

---

## GitHub Actions Integration

You can automate release note generation using GitHub Actions so that every time a new tag is pushed, your multi-agent system generates release notes automatically.  

### How It Works

- The workflow triggers whenever a new tag is pushed.  
- Automatically determines the previous tag (`START_COMMIT`) and current tag (`END_COMMIT`).  
- Generates release notes using your multi-agent system.  
- Commits the updated `release_notes.txt` back to the repository.  

This setup ensures your release notes are always up-to-date and fully automated.

---

## Contributing

Contributions are welcome!  
1. Fork the repository.  
2. Create a new branch (`git checkout -b feature/my-feature`).  
3. Commit your changes (`git commit -m 'Add feature'`).  
4. Push to the branch (`git push origin feature/my-feature`).  
5. Open a Pull Request.  

---

## License

Distributed under the MIT License. See `LICENSE` for more information.  

---

## Acknowledgements

- [Best-README-Template](https://github.com/othneildrew/Best-README-Template)  
- [Google Generative AI](https://developers.generativeai.google/)  
- [GitHub API](https://docs.github.com/en/rest)
