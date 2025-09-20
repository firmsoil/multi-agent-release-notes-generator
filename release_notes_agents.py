#!/usr/bin/env python3
# release_notes_agents.py
# Multi-agent release notes generator (local + GitHub modes)
#
# See README.md for testing instructions.
import argparse
import os
import textwrap

# Optional dependencies (used only in GitHub mode)
try:
    from github import Github
    HAS_PYGITHUB = True
except Exception:
    HAS_PYGITHUB = False

try:
    import requests
    HAS_REQUESTS = True
except Exception:
    HAS_REQUESTS = False

# Try to import Google GenAI (GADK). If not installed, we'll fall back to a simple LLM stub.
try:
    from google import genai
    from google.genai.agents import Agent, Orchestrator  # optional; only used if available
    HAS_GENAI = True
except Exception:
    HAS_GENAI = False

class LLMWrapper:
    def __init__(self, genai_api_key=None):
        self.use_genai = False
        self.genai_api_key = genai_api_key or os.getenv("GENAI_API_KEY") or None
        if HAS_GENAI and self.genai_api_key:
            try:
                try:
                    genai.configure(api_key=self.genai_api_key)
                except Exception:
                    pass
                try:
                    self.llm = genai.LLM(model="claude-3-opus")
                except Exception:
                    self.llm = None
                self.use_genai = True
            except Exception as e:
                print("Warning: could not initialize GADK client, falling back to local summarizer:", e)
                self.use_genai = False

    def generate(self, prompt: str) -> str:
        if self.use_genai and getattr(self, 'llm', None) is not None:
            try:
                resp = self.llm.generate(prompt=prompt)
                if isinstance(resp, dict):
                    cands = resp.get('candidates') or resp.get('outputs') or resp.get('choices')
                    if cands and isinstance(cands, (list, tuple)):
                        first = cands[0]
                        if isinstance(first, dict):
                            return first.get('content') or first.get('text') or str(first)
                        return str(first)
                    return str(resp)
                else:
                    return str(resp)
            except Exception as e:
                print("GENAI call failed, falling back to local summarizer:", e)
                self.use_genai = False
        return self._simple_summarize(prompt)

    def _simple_summarize(self, text: str) -> str:
        lines = [l.strip() for l in text.splitlines() if l.strip() and '[skip ci]' not in l.lower()]
        keywords = ['fix', 'bug', 'perf', 'performance', 'add', 'feature', 'refactor', 'security', 'upgrade', 'remove']
        scored = []
        for l in lines:
            score = 0
            lower = l.lower()
            for k in keywords:
                if k in lower:
                    score += 2
            score += max(0, 3 - len(l.split()))
            scored.append((score, l))
        scored.sort(reverse=True, key=lambda x: x[0])
        result = []
        for s, l in scored[:8]:
            result.append(l)
        if not result:
            result = lines[:6]
        return '\n'.join(result)

class CommitCuratorAgent:
    def __init__(self, llm: LLMWrapper):
        self.llm = llm
    def run(self, commits_text: str) -> str:
        prompt = textwrap.dedent(f"""        You are a Commit Curator.
        Input (commit messages or raw commit list):
        {commits_text}

        Task: Return a concise summary (3-8 lines) of the most user-facing, user-impacting commits.
        Ignore commits that include [skip ci].
        Keep output short and user-friendly.
        """)
        return self.llm.generate(prompt)

class ChangeDiffAnalyzerAgent:
    def __init__(self, llm: LLMWrapper):
        self.llm = llm
    def run(self, diff_text: str) -> str:
        prompt = textwrap.dedent(f"""        You are a Change Diff Analyzer.
        Input (diff/patch text):
        {diff_text}

        Task: Identify functional/technical changes (bug fixes, performance gains, new features) and return a short high-level summary of improvements.
        """)
        return self.llm.generate(prompt)

class PRContextAgent:
    def __init__(self, llm: LLMWrapper):
        self.llm = llm
    def run(self, pr_text: str) -> str:
        prompt = textwrap.dedent(f"""        You are a PR Context Agent.
        Input (PR titles and descriptions):
        {pr_text}

        Task: Capture intent and rationale behind the changes and produce a short contextual summary useful to end-users.
        """)
        return self.llm.generate(prompt)

class ReleaseNotesBuilderAgent:
    def __init__(self, llm: LLMWrapper):
        self.llm = llm
    def run(self, curated_commits: str, diff_summary: str, pr_context: str, version: str, product: str) -> str:
        prompt = textwrap.dedent(f"""        You are a Release Notes Builder.

        Product: {product}
        Version: {version}

        Commits Summary:
        {curated_commits}

        Diff Summary:
        {diff_summary}

        PR Context:
        {pr_context}

        Task: Combine all of the above into a cohesive, engaging set of release notes for end-users.
        - Keep it short and focused on the most important user-facing changes.
        - Tell a story rather than listing raw commits.
        - Use emojis sparingly and naturally.
        - Output plain text only (no markdown).
        """)
        return self.llm.generate(prompt)

def fetch_commits_and_diffs_github(repo_url: str, start_commit: str, end_commit: str, github_token: str):
    if not HAS_PYGITHUB:
        raise RuntimeError("PyGithub is required for GitHub mode (pip install PyGithub)")
    if not HAS_REQUESTS:
        raise RuntimeError("requests is required for GitHub mode (pip install requests)")
    g = Github(github_token)
    repo_name = repo_url.split("github.com/")[-1].replace('.git', '').strip('/')
    repo = g.get_repo(repo_name)
    comparison = repo.compare(start_commit, end_commit)
    commits = [c.commit.message for c in comparison.commits]
    commit_shas = [c.sha for c in comparison.commits]
    commits_text = '\n'.join(commits)
    diff_text = ''
    try:
        diff_url = comparison.diff_url
        headers = {"Authorization": f"token {github_token}"}
        r = requests.get(diff_url, headers=headers)
        diff_text = r.text
    except Exception:
        changed_files = [f.filename for f in getattr(comparison, 'files', [])]
        diff_text = '\n'.join(changed_files) or 'No diff available.'
    return commits_text, diff_text, commit_shas

def fetch_prs_for_commits(repo, commit_shas):
    prs = repo.get_pulls(state='closed')
    relevant = []
    sha_set = set(commit_shas)
    for pr in prs:
        try:
            if pr.merge_commit_sha and pr.merge_commit_sha in sha_set:
                relevant.append(f"PR #{pr.number}: {pr.title}\n{pr.body or ''}")
        except Exception:
            continue
    return '\n'.join(relevant)

def generate_release_notes(version: str, product: str,
                           mode: str = 'local',
                           commits_file: str = None,
                           diff_file: str = None,
                           prs_file: str = None,
                           repo_url: str = None,
                           start_commit: str = None,
                           end_commit: str = None,
                           github_token: str = None,
                           genai_api_key: str = None) -> str:
    llm = LLMWrapper(genai_api_key)
    commit_agent = CommitCuratorAgent(llm)
    diff_agent = ChangeDiffAnalyzerAgent(llm)
    pr_agent = PRContextAgent(llm)
    builder_agent = ReleaseNotesBuilderAgent(llm)
    if mode == 'local':
        if not (commits_file and diff_file and prs_file):
            raise ValueError('Local mode requires --commits --diff --prs file paths.')
        with open(commits_file, 'r', encoding='utf-8') as f:
            commits_text = f.read()
        with open(diff_file, 'r', encoding='utf-8') as f:
            diff_text = f.read()
        with open(prs_file, 'r', encoding='utf-8') as f:
            pr_text = f.read()
    elif mode == 'github':
        if not (repo_url and start_commit and end_commit and github_token):
            raise ValueError('GitHub mode requires --repo --start --end and GITHUB token.')
        if not HAS_PYGITHUB:
            raise RuntimeError('PyGithub not installed. pip install PyGithub')
        g = Github(github_token)
        repo_name = repo_url.split("github.com/")[-1].replace('.git', '').strip('/')
        repo = g.get_repo(repo_name)
        commits_text, diff_text, commit_shas = fetch_commits_and_diffs_github(repo_url, start_commit, end_commit, github_token)
        pr_text = fetch_prs_for_commits(repo, commit_shas)
    else:
        raise ValueError('mode must be local or github')
    curated = commit_agent.run(commits_text)
    diff_summary = diff_agent.run(diff_text)
    pr_context = pr_agent.run(pr_text)
    notes = builder_agent.run(curated, diff_summary, pr_context, version, product)
    return notes

def main():
    parser = argparse.ArgumentParser(description='Multi-agent Release Notes Generator', formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument('--mode', choices=['local', 'github'], default='local')
    parser.add_argument('--commits', help='path to commits text file (local mode)')
    parser.add_argument('--diff', help='path to diff text file (local mode)')
    parser.add_argument('--prs', help='path to prs text file (local mode)')
    parser.add_argument('--repo', help='GitHub repo URL (https://github.com/owner/repo.git) for github mode')
    parser.add_argument('--start', help='start commit SHA (for github mode)')
    parser.add_argument('--end', help='end commit SHA (for github mode)')
    parser.add_argument('--version', required=True, help='release version label, e.g. v1.2.3')
    parser.add_argument('--product', required=True, help='product name for release notes header')
    parser.add_argument('--genai-key', help='GENAI API key (optional) - if not provided, GENAI_API_KEY env var is used')
    parser.add_argument('--github-token', help='GitHub token (optional) - if not provided, GITHUB_TOKEN env var is used')
    parser.add_argument('--out', default='release_notes.txt', help='output filename to write notes to')
    args = parser.parse_args()
    github_token = args.github_token or os.getenv('GITHUB_TOKEN')
    genai_key = args.genai_key or os.getenv('GENAI_API_KEY')
    notes = generate_release_notes(version=args.version, product=args.product, mode=args.mode,
                                   commits_file=args.commits, diff_file=args.diff, prs_file=args.prs,
                                   repo_url=args.repo, start_commit=args.start, end_commit=args.end,
                                   github_token=github_token, genai_api_key=genai_key)
    print('\n===== GENERATED RELEASE NOTES =====\n')
    print(notes)
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(notes)
    print(f'\nWritten to {args.out}')
if __name__ == '__main__':
    main()
