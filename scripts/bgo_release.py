#!/usr/bin/env python3
"""Build portable release bundles and publish a complete, new draft only.

No mutation retries or cleanup: uncertain outcomes require human inspection.
GitHub releases/tags/assets are not a cross-resource atomic transaction.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

PLATFORMS = ('ubuntu-x64', 'ubuntu-armv7', 'ubuntu-arm64', 'macos-x64', 'macos-arm64', 'windows-x64')
REQUIRED = {'index.cjs', 'appConfig.json', 'node_modules/better-sqlite3/package.json',
            'node_modules/@napi-rs/canvas/package.json', 'node_modules/font-ls/package.json'}
WORKFLOW = '.github/workflows/for-bgo.yml'
REPOSITORY = 'kira1928/biliLive-tools'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


@dataclass(frozen=True)
class Context:
    repo: str
    sha: str
    run: int
    attempt: int
    ref: str
    tag: str = ''
    name: str = ''


def context():
    return Context(os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_SHA'],
                   int(os.environ['GITHUB_RUN_ID']), int(os.environ['GITHUB_RUN_ATTEMPT']),
                   os.environ['GITHUB_REF'])


def release_context():
    ctx = context()
    require(ctx.repo == REPOSITORY and ctx.ref == 'refs/heads/for-bgo',
            'Manual releases require the intended repository and for-bgo branch')
    require(os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch', 'Manual dispatch required')
    with open(os.environ['GITHUB_EVENT_PATH'], encoding='utf-8') as handle:
        event = json.load(handle)
    inputs = event.get('inputs', {})
    require(inputs.get('is_release') in (True, 'true'), 'Explicit is_release=true required')
    require(inputs.get('force_replace', False) in (False, 'false', None, ''),
            'force_replace is no longer supported')
    tag = inputs.get('release_tag', '')
    name = inputs.get('release_name', '') or tag
    require(isinstance(tag, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', tag),
            'Invalid release tag')
    subprocess.run(['git', 'check-ref-format', 'refs/tags/' + tag], check=True)
    require(isinstance(name, str) and len(name) <= 200 and
            all(ord(c) >= 32 and ord(c) != 127 for c in name), 'Invalid release name')
    return Context(ctx.repo, ctx.sha, ctx.run, ctx.attempt, ctx.ref, tag, name)


def asset_name(platform):
    require(platform in PLATFORMS, 'Unknown platform')
    return 'bililive-cli-lib-' + platform + '.zip'


def sha256(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def safe_entries(archive):
    seen, files = set(), set()
    for entry in archive.infolist():
        # ZipInfo normalizes Windows separators and truncates at NUL. Validate
        # the original decoded member name before trusting the normalized name.
        raw_name = entry.orig_filename
        require('\\' not in raw_name and '\x00' not in raw_name, 'Unsafe original ZIP path')
        name = entry.filename
        require(name and '\\' not in name and '\x00' not in name and ':' not in name and
                not name.startswith('/') and
                all(p not in ('', '.', '..') for p in name.rstrip('/').split('/')), 'Unsafe ZIP path')
        key = name.rstrip('/')
        require(key not in seen, 'Duplicate ZIP entry')
        seen.add(key)
        mode = entry.external_attr >> 16
        kind = stat.S_IFMT(mode)
        require(kind in (0, stat.S_IFREG, stat.S_IFDIR), 'Symlink or special file rejected')
        require(kind != stat.S_IFDIR or entry.is_dir(), 'Inconsistent directory mode')
        require(kind != stat.S_IFREG or not entry.is_dir(), 'Inconsistent regular file mode')
        require(not entry.flag_bits & 1, 'Encrypted ZIP rejected')
        if not entry.is_dir():
            files.add(name)
    for name in seen:
        parts = name.split('/')
        require(all('/'.join(parts[:i]) not in files for i in range(1, len(parts))),
                'File/directory conflict')
    return files


def validate_zip(path):
    with zipfile.ZipFile(path) as archive:
        require(REQUIRED <= safe_entries(archive), 'Package root entry points missing')
        require(archive.testzip() is None, 'Corrupt ZIP')


def pack(root, output, platform, ctx):
    root, output = Path(root), Path(output)
    require(root.is_dir() and not root.is_symlink(), 'Invalid package root')
    output.mkdir(parents=True, exist_ok=True)
    destination = output / asset_name(platform)
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        # pathlib includes dotfiles; no shell glob. Reject links instead of following them.
        for path in sorted(root.rglob('*')):
            require(not path.is_symlink(), 'Package symlink rejected')
            require(path.is_file() or path.is_dir(), 'Package special file rejected')
            archive.write(path, path.relative_to(root).as_posix())
    validate_zip(destination)
    tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    require(head == ctx.sha, 'Checkout does not match source SHA')
    manifest = dict(schema=1, repository=ctx.repo, sha=ctx.sha, tree=tree,
                    run_id=ctx.run, run_attempt=ctx.attempt, platform=platform,
                    filename=destination.name, sha256=sha256(destination), size=destination.stat().st_size)
    (output / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True) + '\n', encoding='utf-8')
    return destination


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(path, method='GET', data=None, binary=False):
    url = path if path.startswith('https://') else 'https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + path
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme == 'https' and parsed.hostname in ('api.github.com', 'uploads.github.com') and
            not parsed.username and not parsed.password, 'Unexpected API destination')
    headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
               'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    if data is not None:
        headers['Content-Type'] = 'application/zip' if binary else 'application/json'
        if not binary:
            data = json.dumps(data).encode()
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    # Deliberately no mutation retry, including timeout/connection failures.
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=180) as response:
        return json.load(response)


def pages(path, key=None):
    result = []
    for page in range(1, 101):
        data = api(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        batch = data[key] if key else data
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise RuntimeError('Pagination limit reached')


def absent(path):
    try:
        api(path)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return
        raise
    raise RuntimeError('Refusing existing tag or release: ' + path)


def ensure_absent(ctx):
    absent('/git/ref/tags/' + urllib.parse.quote(ctx.tag, safe=''))
    absent('/releases/tags/' + urllib.parse.quote(ctx.tag, safe=''))
    require(not any(r['tag_name'] == ctx.tag for r in pages('/releases')),
            'Existing release or draft found')


def validate_builds(ctx):
    run = api('/actions/runs/' + str(ctx.run))
    require(run['repository']['full_name'] == ctx.repo and run['head_repository']['full_name'] == ctx.repo and
            run['head_sha'] == ctx.sha and run['head_branch'] == ctx.ref.removeprefix('refs/heads/') and
            run['path'] == WORKFLOW and run['run_attempt'] == ctx.attempt and
            run['event'] == 'workflow_dispatch' and run['status'] == 'in_progress' and
            run['conclusion'] is None, 'Run identity/status mismatch')
    # The publisher is IN PROGRESS; run-level success would be impossible here.
    expected = {'build (' + p.replace('-', ', ', 1) + ')' for p in PLATFORMS}
    latest = {}
    for attempt in range(1, ctx.attempt + 1):
        jobs = pages(f'/actions/runs/{ctx.run}/attempts/{attempt}/jobs', 'jobs')
        seen = set()
        for job in jobs:
            name = job['name']
            require(name not in seen, 'Duplicate job name')
            seen.add(name)
            require(job['run_id'] == ctx.run and job['head_sha'] == ctx.sha and
                    job.get('run_attempt', attempt) == attempt, 'Job identity mismatch')
            require(name in expected or name in ('validate-release', 'publish'), 'Unexpected workflow job')
            if name in expected:
                latest[name] = job
    require(set(latest) == expected and all(j['status'] == 'completed' and j['conclusion'] == 'success'
                                           for j in latest.values()), 'All six latest build jobs must succeed')


def validate_bundle(wrapper_zip, destination, platform, ctx):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    name = asset_name(platform)
    with zipfile.ZipFile(wrapper_zip) as archive:
        require(safe_entries(archive) == {name, 'manifest.json'} and len(archive.infolist()) == 2,
                'Unexpected bundle contents')
        require(archive.getinfo('manifest.json').file_size < 16384, 'Oversized manifest')
        manifest = json.loads(archive.read('manifest.json'))
        require(manifest['schema'] == 1 and manifest['repository'] == ctx.repo and
                manifest['sha'] == ctx.sha and manifest['run_id'] == ctx.run and
                type(manifest['run_attempt']) is int and 1 <= manifest['run_attempt'] <= ctx.attempt and
                manifest['platform'] == platform and manifest['filename'] == name,
                'Bundle provenance mismatch')
        tree = api('/git/commits/' + ctx.sha)['tree']['sha']
        require(manifest['tree'] == tree, 'Source tree mismatch')
        path = destination / name
        with archive.open(name) as source, path.open('wb') as target:
            shutil.copyfileobj(source, target)
    require(path.stat().st_size == manifest['size'] and sha256(path) == manifest['sha256'],
            'Package digest/size mismatch')
    validate_zip(path)
    return path


def download(artifact, destination):
    try:
        api('/actions/artifacts/' + str(artifact['id']) + '/zip')
    except urllib.error.HTTPError as exc:
        require(exc.code == 302, 'Artifact download did not redirect')
        url = exc.headers['Location']
    else:
        raise RuntimeError('Unexpected artifact download response')
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme == 'https' and not parsed.username and not parsed.password,
            'Unsafe storage redirect')
    # Signed URL from GitHub; no authorization header is sent to storage.
    with urllib.request.build_opener(NoRedirect()).open(url, timeout=180) as response:
        with Path(destination).open('wb') as target:
            shutil.copyfileobj(response, target)
    require(sha256(destination) == artifact['digest'].removeprefix('sha256:'), 'Artifact digest mismatch')


def fetch_artifacts(ctx, destination):
    artifacts = pages(f'/actions/runs/{ctx.run}/artifacts', 'artifacts')
    expected = {'bgo-release-' + p: p for p in PLATFORMS}
    require(len(artifacts) == 6 and {a['name'] for a in artifacts} == set(expected),
            'Missing, duplicate or unexpected artifacts')
    require(len({a['id'] for a in artifacts}) == 6, 'Duplicate artifact ID')
    paths = []
    for artifact in artifacts:
        require(not artifact['expired'] and artifact['size_in_bytes'] > 0 and
                artifact['workflow_run']['id'] == ctx.run and artifact['workflow_run']['head_sha'] == ctx.sha and
                re.fullmatch(r'sha256:[0-9a-f]{64}', artifact.get('digest') or ''), 'Artifact provenance mismatch')
        wrapper = Path(destination) / (str(artifact['id']) + '.zip')
        download(artifact, wrapper)
        paths.append(validate_bundle(wrapper, destination, expected[artifact['name']], ctx))
    return paths


def verify_assets(ctx, rid, expected):
    remote = pages(f'/releases/{rid}/assets')
    require(len(remote) == 6 and {a['name'] for a in remote} == set(expected), 'Incomplete release assets')
    for asset in remote:
        size, digest = expected[asset['name']]
        require(asset['state'] == 'uploaded' and asset['size'] == size and
                asset.get('digest') == 'sha256:' + digest, 'Release asset verification failed')


def check_tag(ctx):
    ref = api('/git/ref/tags/' + urllib.parse.quote(ctx.tag, safe=''))
    require(ref['object']['type'] == 'commit' and ref['object']['sha'] == ctx.sha, 'Tag changed')


def source_versions(root=None):
    """Read release metadata from the checked-out source, never dispatch text."""
    root = Path(root) if root is not None else Path(__file__).resolve().parent.parent
    with (root / 'packages/CLI/package.json').open(encoding='utf-8') as handle:
        version = json.load(handle)['version']
    node = (root / '.node-version').read_text(encoding='utf-8').strip()
    require(isinstance(version, str) and re.fullmatch(
        r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?', version),
        'Invalid source CLI version')
    require(re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', node),
            'Invalid pinned Node runtime')
    return version, node


def publish(ctx, assets, validate_source=None):
    # Internal integration hook for separately reviewed, fixed-source publishers.
    # The manual CLI never accepts a validator from inputs or environment.
    validate_source = validate_source or validate_builds
    version, node = source_versions()
    require(len(assets) == 6 and {p.name for p in assets} == {asset_name(p) for p in PLATFORMS},
            'Expected six local assets')
    expected = {}
    for path in assets:
        validate_zip(path)
        expected[path.name] = (path.stat().st_size, sha256(path))
    validate_source(ctx)
    ensure_absent(ctx)
    # No tag move, asset replacement, deletion, or automatic retry anywhere below.
    api('/git/refs', 'POST', {'ref': 'refs/tags/' + ctx.tag, 'sha': ctx.sha})
    print('Created new tag: ' + ctx.tag, flush=True)
    release = api('/releases', 'POST', {
        'tag_name': ctx.tag, 'target_commitish': ctx.sha, 'name': ctx.name or ctx.tag,
        'draft': True, 'prerelease': False,
        'body': f'biliLive-tools {version} CLI for bililive-go.\n'
                f'Required Node.js runtime: {node}.\n\nSource: `{ctx.sha}`\nBuild: '
                f'https://github.com/{ctx.repo}/actions/runs/{ctx.run}\n\n'
                'Six platform archives verified before publication.'})
    rid = release['id']
    print(f'Created draft release ID {rid}; inspect it if this run stops.', flush=True)
    require(release['draft'] and release['tag_name'] == ctx.tag, 'Unexpected draft response')
    upload = release['upload_url'].split('{', 1)[0]
    parsed = urllib.parse.urlparse(upload)
    require(parsed.scheme == 'https' and parsed.netloc == 'uploads.github.com' and
            parsed.path == f'/repos/{ctx.repo}/releases/{rid}/assets', 'Unexpected upload URL')
    for path in assets:
        asset = api(upload + '?name=' + urllib.parse.quote(path.name, safe=''), 'POST', path.read_bytes(), binary=True)
        require(asset['state'] == 'uploaded' and asset['name'] == path.name and
                asset['size'] == expected[path.name][0], 'Upload response mismatch')
    validate_source(ctx)
    check_tag(ctx)
    current = api(f'/releases/{rid}')
    require(current['id'] == rid and current['draft'] and current['tag_name'] == ctx.tag, 'Draft changed')
    verify_assets(ctx, rid, expected)
    final = api(f'/releases/{rid}', 'PATCH', {'draft': False})
    require(final['id'] == rid and not final['draft'] and final['tag_name'] == ctx.tag, 'Publication response mismatch')
    check_tag(ctx)
    verify_assets(ctx, rid, expected)
    print('Published: ' + final['html_url'], flush=True)
    return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('pack', 'validate', 'publish'))
    parser.add_argument('--platform', choices=PLATFORMS)
    parser.add_argument('--root', default='packages/CLI/lib')
    parser.add_argument('--output', default='release-bundle')
    args = parser.parse_args()
    if args.command == 'pack':
        pack(args.root, args.output, args.platform, context())
        return
    ctx = release_context()
    ensure_absent(ctx)
    if args.command == 'validate':
        return
    try:
        validate_builds(ctx)
        with tempfile.TemporaryDirectory() as directory:
            assets = fetch_artifacts(ctx, directory)
            final = publish(ctx, assets)
        summary = f"Published [{ctx.tag}]({final['html_url']}) at `{ctx.sha}` with six verified assets.\n"
    except Exception:
        summary = ('Publishing stopped. No automatic retries or cleanup were attempted. '
                   'Inspect this run, the new tag and any draft before another attempt. '
                   'An ambiguous response may mean publication succeeded; check remote state first.\n')
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as handle:
            handle.write(summary)
        raise
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as handle:
        handle.write(summary)


if __name__ == '__main__':
    main()
