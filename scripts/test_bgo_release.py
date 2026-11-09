"""Local-only release safety tests. All GitHub requests are mocked."""
import copy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import urllib.parse
import zipfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('bgo_release', ROOT / 'scripts/bgo_release.py')
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.ctx = p.Context('kira1928/biliLive-tools', 'a' * 40, 123, 2,
                             'refs/heads/for-bgo', '4.1.0-bgo.1', 'Release')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        def reject_unmocked_api(path, *args, **kwargs):
            if path == '/git/commits/' + self.ctx.sha:
                return {'tree': {'sha': 'b' * 40}}
            raise AssertionError('Unmocked GitHub request: ' + path)
        guard = patch.object(p, 'api', side_effect=reject_unmocked_api)
        guard.start()
        self.addCleanup(guard.stop)
        # Publisher messages describe simulated operations, never real mutations.
        output = redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def archive(self, path=None, extra=None, omit=None):
        path = path or self.root / 'package.zip'
        with zipfile.ZipFile(path, 'w') as z:
            for name in sorted(p.REQUIRED):
                if name != omit:
                    z.writestr(name, b'package bytes')
            if extra:
                entry, data = extra
                if isinstance(entry, str):
                    # Write the hostile bytes as supplied. ZipInfo construction
                    # would otherwise normalize backslashes on Windows or NUL.
                    raw_name = entry
                    entry = zipfile.ZipInfo('placeholder')
                    entry.filename = entry.orig_filename = raw_name
                z.writestr(entry, data)
        return path

    def assets(self):
        return [self.archive(self.root / p.asset_name(platform)) for platform in p.PLATFORMS]

    def test_root_layout_and_hidden_files(self):
        archive = self.archive(extra=('.hidden', b'hidden'))
        p.validate_zip(archive)
        with zipfile.ZipFile(archive) as z:
            self.assertEqual(z.read('.hidden'), b'hidden')

    def test_archive_rejects_paths_and_missing_entry_points(self):
        for name in ['../outside', '/absolute', 'C:/drive', 'a\\b', 'safe\x00hidden', 'a//b', './a', 'a/../b']:
            with self.subTest(name=name), self.assertRaises((RuntimeError, ValueError)):
                p.validate_zip(self.archive(extra=(name, b'x')))
        with self.assertRaises((RuntimeError, ValueError)):
            p.validate_zip(self.archive(omit='appConfig.json'))
        with self.assertRaises((RuntimeError, ValueError)):
            p.validate_zip(self.archive(omit='appConfig.json', extra=('appConfig.json/', b'')))

    def test_original_names_reject_windows_separator_and_nul_normalization(self):
        for raw_name, normalized in [('a\\b', 'a/b'), ('safe\x00hidden', 'safe')]:
            path = self.archive(extra=(raw_name, b'hostile'))
            # Simulate Windows ZIP filename normalization on every host. This
            # patches separators only, never skips the dangerous-name check.
            with self.subTest(raw_name=raw_name), patch.object(zipfile.os, 'sep', '\\'), \
                    patch.object(zipfile.os, 'altsep', '/'):
                with zipfile.ZipFile(path) as archive:
                    entry = archive.infolist()[-1]
                    self.assertEqual(entry.orig_filename, raw_name)
                    self.assertEqual(entry.filename, normalized)
                    with self.assertRaisesRegex(RuntimeError, 'Unsafe original ZIP path'):
                        p.safe_entries(archive)
                with self.assertRaisesRegex(RuntimeError, 'Unsafe original ZIP path'):
                    p.validate_zip(path)

    def test_archive_rejects_duplicates_conflicts_and_special_files(self):
        for extra in [('index.cjs', b'duplicate'), ('node_modules', b'file')]:
            with self.subTest(extra=extra), self.assertRaises((RuntimeError, ValueError)):
                p.validate_zip(self.archive(extra=extra))
        for kind in [stat.S_IFLNK, stat.S_IFIFO, stat.S_IFSOCK]:
            entry = zipfile.ZipInfo('special')
            entry.create_system = 3
            entry.external_attr = (kind | 0o777) << 16
            with self.subTest(kind=kind), self.assertRaises((RuntimeError, ValueError)):
                p.validate_zip(self.archive(extra=(entry, b'../outside')))

    def test_pack_preserves_hidden_files_and_executable_mode(self):
        source, output = self.root / 'lib', self.root / 'output'
        for name in p.REQUIRED | {'.hidden', 'bin/tool'}:
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'contents')
        (source / 'bin/tool').chmod(0o755)
        with patch.object(p.subprocess, 'check_output', side_effect=['b' * 40 + '\n', self.ctx.sha + '\n']):
            p.pack(source, output, 'ubuntu-x64', self.ctx)
        archive = output / p.asset_name('ubuntu-x64')
        p.validate_zip(archive)
        with zipfile.ZipFile(archive) as z:
            self.assertEqual(z.read('.hidden'), b'contents')
            if os.name != 'nt':
                self.assertEqual((z.getinfo('bin/tool').external_attr >> 16) & 0o777, 0o755)
        manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['sha256'], p.sha256(archive))
        self.assertEqual(manifest['size'], archive.stat().st_size)
        self.assertEqual(manifest['sha'], self.ctx.sha)

    def bundle(self, manifest_changes=None, extra=None, corrupt=False):
        archive = self.archive()
        platform = 'ubuntu-x64'
        manifest = {'schema': 1, 'repository': self.ctx.repo, 'sha': self.ctx.sha,
                    'tree': 'b' * 40, 'run_id': self.ctx.run, 'run_attempt': 1,
                    'platform': platform, 'filename': p.asset_name(platform),
                    'sha256': p.sha256(archive), 'size': archive.stat().st_size}
        manifest.update(manifest_changes or {})
        wrapper = self.root / 'wrapper.zip'
        with zipfile.ZipFile(wrapper, 'w') as z:
            z.writestr('manifest.json', json.dumps(manifest))
            z.writestr(p.asset_name(platform), b'broken' if corrupt else archive.read_bytes())
            if extra:
                z.writestr(*extra)
        return wrapper

    def test_bundle_accepts_retained_success_from_earlier_attempt(self):
        target = self.root / 'validated'
        target.mkdir()
        path = p.validate_bundle(self.bundle(), target, 'ubuntu-x64', self.ctx)
        p.validate_zip(path)

    def test_bundle_rejects_bad_provenance_hash_and_wrapper(self):
        mutations = [{'repository': 'other/repo'}, {'sha': 'c' * 40}, {'run_id': 124},
                     {'run_attempt': 3}, {'run_attempt': 0}, {'platform': 'windows-x64'},
                     {'filename': '../outside.zip'}, {'sha256': '0' * 64}, {'size': 1},
                     {'schema': 99}]
        target = self.root / 'validated'
        target.mkdir()
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises((RuntimeError, ValueError)):
                p.validate_bundle(self.bundle(mutation), target, 'ubuntu-x64', self.ctx)
        with self.assertRaises((RuntimeError, ValueError)):
            p.validate_bundle(self.bundle(extra=('../escape', b'x')), target, 'ubuntu-x64', self.ctx)
        with self.assertRaises((RuntimeError, ValueError)):
            p.validate_bundle(self.bundle(corrupt=True), target, 'ubuntu-x64', self.ctx)

    def run_fixture(self):
        return {'repository': {'full_name': self.ctx.repo}, 'head_repository': {'full_name': self.ctx.repo},
                'head_sha': self.ctx.sha, 'head_branch': 'for-bgo', 'event': 'workflow_dispatch',
                'path': '.github/workflows/for-bgo.yml', 'run_attempt': 2,
                'status': 'in_progress', 'conclusion': None}

    def jobs_fixture(self, attempt=2):
        return [{'id': i + attempt * 100, 'name': 'build (' + platform.replace('-', ', ') + ')',
                 'run_id': self.ctx.run, 'run_attempt': attempt, 'head_sha': self.ctx.sha,
                 'status': 'completed', 'conclusion': 'success',
                 'started_at': '2026-11-09T16:00:00Z', 'completed_at': '2026-11-09T16:10:00Z'}
                for i, platform in enumerate(p.PLATFORMS)]

    def builds(self, run=None, snapshots=None):
        run = run or self.run_fixture()
        snapshots = snapshots or [self.jobs_fixture(1), self.jobs_fixture(2)]
        def api(path, *args, **kwargs):
            if path == '/actions/runs/123': return run
            raise AssertionError('Unexpected API request ' + path)
        def pages(path, key=None):
            for attempt in [1, 2]:
                if f'/attempts/{attempt}/jobs' in path: return snapshots[attempt - 1]
            raise AssertionError('Unexpected list ' + path)
        with patch.object(p, 'api', side_effect=api), patch.object(p, 'pages', side_effect=pages):
            p.validate_builds(self.ctx)

    def test_in_progress_run_and_cloned_successful_jobs_allowed(self):
        self.builds()

    def test_partial_rerun_retains_earlier_successes(self):
        first = self.jobs_fixture(1)
        first[-1]['conclusion'] = 'cancelled'
        self.builds(snapshots=[first, [self.jobs_fixture(2)[-1]]])

    def test_build_validation_rejects_failed_missing_or_wrong_identity(self):
        for mutation in ['failure', 'cancelled', 'queued', 'missing', 'wrong_sha', 'wrong_run', 'duplicate']:
            jobs = self.jobs_fixture(2)
            if mutation in ['failure', 'cancelled']: jobs[0]['conclusion'] = mutation
            if mutation == 'queued': jobs[0]['status'] = 'queued'
            if mutation == 'missing': jobs.pop()
            if mutation == 'wrong_sha': jobs[0]['head_sha'] = 'f' * 40
            if mutation == 'wrong_run': jobs[0]['run_id'] = 456
            if mutation == 'duplicate': jobs.append(copy.deepcopy(jobs[0]))
            with self.subTest(mutation=mutation), self.assertRaises((RuntimeError, ValueError)):
                self.builds(snapshots=[[{**j, 'run_attempt': 1} for j in jobs], jobs])
        for field, value in [('head_sha', '0' * 40), ('run_attempt', 3), ('event', 'push'),
                             ('path', '.github/workflows/other.yml'), ('head_branch', 'other'),
                             ('status', 'completed'), ('conclusion', 'cancelled')]:
            run = self.run_fixture(); run[field] = value
            with self.subTest(field=field), self.assertRaises((RuntimeError, ValueError)):
                self.builds(run=run)

    def test_existing_tag_release_or_draft_never_mutated(self):
        for existing in ['tag', 'release', 'draft']:
            calls = []
            def api(path, method='GET', **kwargs):
                calls.append((path, method))
                if (existing == 'tag' and '/git/ref/tags/' in path) or (existing == 'release' and '/releases/tags/' in path):
                    return {'id': 7}
                raise urllib.error.HTTPError(path, 404, 'Not Found', {}, None)
            with self.subTest(existing=existing), patch.object(p, 'api', side_effect=api), patch.object(p, 'pages', return_value=[{'tag_name': self.ctx.tag}] if existing == 'draft' else []):
                with self.assertRaises((RuntimeError, ValueError)):
                    p.ensure_absent(self.ctx)
                self.assertTrue(all(method == 'GET' for _, method in calls))

    def test_absence_check_fails_closed_for_api_errors(self):
        for code in [401, 403, 429, 500]:
            error = urllib.error.HTTPError('https://api.github.com', code, 'error', {}, None)
            with self.subTest(code=code), patch.object(p, 'api', side_effect=error), self.assertRaises(urllib.error.HTTPError):
                p.ensure_absent(self.ctx)

    def publication(self, fail_mutation=None, bad_remote=None):
        assets = self.assets()
        calls, mutations = [], []
        remote = [{'id': i + 1, 'name': a.name, 'size': a.stat().st_size, 'state': 'uploaded',
                   'digest': 'sha256:' + p.sha256(a)} for i, a in enumerate(assets)]
        if bad_remote == 'missing': remote.pop()
        if bad_remote == 'duplicate': remote[-1] = copy.deepcopy(remote[0])
        if bad_remote == 'digest': remote[0]['digest'] = 'sha256:' + '0' * 64
        if bad_remote == 'missing_digest': remote[0].pop('digest')
        if bad_remote == 'size': remote[0]['size'] += 1
        if bad_remote == 'state': remote[0]['state'] = 'starter'
        draft = {'id': 7, 'draft': True, 'tag_name': self.ctx.tag,
                 'target_commitish': self.ctx.sha,
                 'upload_url': 'https://uploads.github.com/repos/kira1928/biliLive-tools/releases/7/assets{?name,label}'}
        def api(path, method='GET', data=None, binary=False):
            calls.append((path, method))
            if method != 'GET':
                mutations.append((path, method))
                if len(mutations) == fail_mutation: raise TimeoutError('Uncertain mutation outcome')
            if path == '/git/refs' and method == 'POST': return {'object': {'type': 'commit', 'sha': self.ctx.sha}}
            if path == '/releases' and method == 'POST':
                version, node = p.source_versions()
                self.assertIn(f'biliLive-tools {version} CLI', data['body'])
                self.assertIn(f'Required Node.js runtime: {node}.', data['body'])
                return copy.deepcopy(draft)
            if path.startswith('https://uploads.github.com/') and method == 'POST':
                name = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)['name'][0]
                a = next(a for a in assets if a.name == name)
                return {'id': assets.index(a) + 1, 'state': 'uploaded', 'name': name, 'size': len(data), 'digest': 'sha256:' + p.sha256(a)}
            if path == '/git/ref/tags/' + self.ctx.tag: return {'object': {'type': 'commit', 'sha': 'c' * 40 if bad_remote == 'tag_changed' else self.ctx.sha}}
            if path == '/releases/7':
                if method == 'PATCH': return {**draft, 'draft': False, 'html_url': 'https://github.com/kira1928/biliLive-tools/releases/tag/' + self.ctx.tag}
                current = copy.deepcopy(draft)
                if bad_remote == 'draft_changed': current['id'] = 8
                if bad_remote == 'draft_public': current['draft'] = False
                return current
            raise AssertionError('Unexpected API request ' + path)
        def pages(path, key=None):
            if path == '/releases/7/assets': return remote
            raise AssertionError('Unexpected list ' + path)
        with patch.object(p, 'api', side_effect=api), patch.object(p, 'pages', side_effect=pages), patch.object(p, 'validate_builds'), patch.object(p, 'ensure_absent'), patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(self.root / 'summary')}):
            if fail_mutation:
                with self.assertRaises(TimeoutError): p.publish(self.ctx, assets)
                self.assertEqual(len(mutations), fail_mutation, 'No mutation may be retried')
            elif bad_remote:
                with self.assertRaises((RuntimeError, ValueError)): p.publish(self.ctx, assets)
                self.assertNotIn(('/releases/7', 'PATCH'), calls)
            else:
                p.publish(self.ctx, assets)
                self.assertEqual(len(mutations), 9)
                self.assertEqual(mutations[0], ('/git/refs', 'POST'))
                self.assertEqual(mutations[1], ('/releases', 'POST'))
                self.assertEqual(mutations[-1], ('/releases/7', 'PATCH'))
            self.assertFalse(any(method == 'DELETE' for _, method in calls))
        return calls

    def test_source_versions_are_validated_checkout_metadata(self):
        source = self.root / 'source'
        package = source / 'packages/CLI/package.json'
        package.parent.mkdir(parents=True)
        runtime = source / '.node-version'
        package.write_text(json.dumps({'version': '4.1.0'}), encoding='utf-8')
        runtime.write_text('v22.23.4\n', encoding='utf-8')
        self.assertEqual(p.source_versions(source), ('4.1.0', 'v22.23.4'))
        for version in ['4.1.0\nInjected', '$(command)', '', 4.1]:
            package.write_text(json.dumps({'version': version}), encoding='utf-8')
            with self.subTest(version=version), self.assertRaises(RuntimeError):
                p.source_versions(source)
        package.write_text(json.dumps({'version': '4.1.0'}), encoding='utf-8')
        for node in ['latest', 'v22', 'v22.23.4\nInjected', '$(command)']:
            runtime.write_text(node, encoding='utf-8')
            with self.subTest(node=node), self.assertRaises(RuntimeError):
                p.source_versions(source)

    def test_invalid_source_versions_block_before_mutations(self):
        with patch.object(p, 'source_versions', side_effect=RuntimeError('Invalid source metadata')), \
                patch.object(p, 'api') as api:
            with self.assertRaises(RuntimeError):
                p.publish(self.ctx, self.assets())
            api.assert_not_called()

    def test_six_complete_assets_uploaded_before_publish(self):
        self.publication()

    def test_timeout_at_every_mutation_never_retries_or_cleans_up(self):
        for stage in range(1, 10):
            with self.subTest(stage=stage):
                self.publication(fail_mutation=stage)

    def test_bad_remote_asset_set_never_published(self):
        for fault in ['missing', 'duplicate', 'digest', 'missing_digest', 'size', 'state', 'tag_changed', 'draft_changed', 'draft_public']:
            with self.subTest(fault=fault): self.publication(bad_remote=fault)

    def test_missing_local_asset_blocks_all_mutations(self):
        with patch.object(p, 'api') as api, patch.object(p, 'validate_builds'), patch.object(p, 'ensure_absent'):
            with self.assertRaises((RuntimeError, ValueError)):
                p.publish(self.ctx, self.assets()[:-1])
            api.assert_not_called()

    def test_changed_build_state_blocks_before_publication(self):
        assets = self.assets()
        with patch.object(p, 'validate_builds', side_effect=RuntimeError('run changed')), patch.object(p, 'api') as api:
            with self.assertRaises(RuntimeError): p.publish(self.ctx, assets)
            api.assert_not_called()
        with patch.object(p, 'validate_builds'), patch.object(p, 'ensure_absent', side_effect=RuntimeError('draft appeared')), patch.object(p, 'api') as api:
            with self.assertRaises(RuntimeError): p.publish(self.ctx, assets)
            api.assert_not_called()

    def test_newer_failed_attempt_overrides_old_success(self):
        first, second = self.jobs_fixture(1), [self.jobs_fixture(2)[0]]
        second[0]['conclusion'] = 'failure'
        with self.assertRaises(RuntimeError): self.builds(snapshots=[first, second])
        first[0]['conclusion'] = 'failure'
        second[0]['conclusion'] = 'success'
        self.builds(snapshots=[first, second])

    def test_release_inputs_are_data_and_legacy_replace_is_rejected(self):
        event = self.root / 'event.json'
        env = {'GITHUB_REPOSITORY': self.ctx.repo, 'GITHUB_SHA': self.ctx.sha,
               'GITHUB_RUN_ID': str(self.ctx.run), 'GITHUB_RUN_ATTEMPT': str(self.ctx.attempt),
               'GITHUB_REF': self.ctx.ref, 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'GITHUB_EVENT_PATH': str(event)}
        inputs = {'is_release': 'true', 'release_tag': self.ctx.tag,
                  'release_name': 'Name $(touch unwanted) "quoted"'}
        event.write_text(json.dumps({'inputs': inputs}), encoding='utf-8')
        with patch.dict(os.environ, env), patch.object(p.subprocess, 'run') as check_ref:
            result = p.release_context()
            self.assertEqual(result.name, inputs['release_name'])
            check_ref.assert_called_once_with(['git', 'check-ref-format', 'refs/tags/' + self.ctx.tag], check=True)
        for changes in [{'release_tag': '$(touch unwanted)'}, {'release_tag': 'a\nb'},
                        {'release_tag': ''}, {'release_name': 'a\nb'},
                        {'force_replace': True}, {'force_replace': 'true'}, {'is_release': 'false'}]:
            event.write_text(json.dumps({'inputs': {**inputs, **changes}}), encoding='utf-8')
            with self.subTest(changes=changes), patch.dict(os.environ, env), self.assertRaises((RuntimeError, ValueError)):
                p.release_context()
        event.write_text(json.dumps({'inputs': {**inputs, 'release_tag': 'a..b'}}), encoding='utf-8')
        with patch.dict(os.environ, env), self.assertRaises(p.subprocess.CalledProcessError):
            p.release_context()
        event.write_text(json.dumps({'inputs': inputs}), encoding='utf-8')
        for changes in [{'GITHUB_REPOSITORY': 'other/repo'}, {'GITHUB_REF': 'refs/heads/other'},
                        {'GITHUB_EVENT_NAME': 'push'}]:
            with self.subTest(changes=changes), patch.dict(os.environ, {**env, **changes}), self.assertRaises(RuntimeError):
                p.release_context()

    def test_pack_rejects_symlink_and_wrong_checkout(self):
        source = self.root / 'lib'
        for name in p.REQUIRED:
            path = source / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'x')
        link = source / 'link'
        if os.name != 'nt':
            link.symlink_to(source / 'index.cjs')
            with self.assertRaises(RuntimeError): p.pack(source, self.root / 'out', 'ubuntu-x64', self.ctx)
            link.unlink()
        with patch.object(p.subprocess, 'check_output', side_effect=['b' * 40, 'c' * 40]), self.assertRaises(RuntimeError):
            p.pack(source, self.root / 'out', 'ubuntu-x64', self.ctx)

    def test_zip_crc_corruption_is_rejected(self):
        path = self.archive()
        content = path.read_bytes().replace(b'package bytes', b'corrupt bytes', 1)
        path.write_bytes(content)
        with self.assertRaises((RuntimeError, zipfile.BadZipFile)):
            p.validate_zip(path)

    def test_bundle_rejects_false_tree_and_duplicate_members(self):
        with self.assertRaises(RuntimeError):
            p.validate_bundle(self.bundle({'tree': 'c' * 40}), self.root / 'out', 'ubuntu-x64', self.ctx)
        with self.assertRaises(RuntimeError):
            p.validate_bundle(self.bundle(extra=('manifest.json', b'{}')), self.root / 'out', 'ubuntu-x64', self.ctx)

    def artifact_fixture(self):
        return [{'id': i + 1, 'name': 'bgo-release-' + platform, 'expired': False,
                 'size_in_bytes': 100, 'digest': 'sha256:' + 'b' * 64,
                 'workflow_run': {'id': self.ctx.run, 'head_sha': self.ctx.sha}}
                for i, platform in enumerate(p.PLATFORMS)]

    def test_artifact_identity_and_digest_are_required(self):
        faults = ['none', 'missing', 'extra', 'duplicate_name', 'duplicate_id', 'expired',
                  'empty', 'missing_digest', 'bad_digest', 'wrong_run', 'wrong_sha']
        for fault in faults:
            artifacts = self.artifact_fixture()
            if fault == 'missing': artifacts.pop()
            if fault == 'extra': artifacts.append(copy.deepcopy(artifacts[0]))
            if fault == 'duplicate_name': artifacts[0]['name'] = artifacts[1]['name']
            if fault == 'duplicate_id': artifacts[0]['id'] = artifacts[1]['id']
            if fault == 'expired': artifacts[0]['expired'] = True
            if fault == 'empty': artifacts[0]['size_in_bytes'] = 0
            if fault == 'missing_digest': artifacts[0].pop('digest')
            if fault == 'bad_digest': artifacts[0]['digest'] = 'md5:' + 'b' * 32
            if fault == 'wrong_run': artifacts[0]['workflow_run']['id'] += 1
            if fault == 'wrong_sha': artifacts[0]['workflow_run']['head_sha'] = 'c' * 40
            with self.subTest(fault=fault), patch.object(p, 'pages', return_value=artifacts), patch.object(p, 'download') as download, patch.object(p, 'validate_bundle', return_value=self.root / 'asset.zip') as bundle:
                if fault == 'none':
                    self.assertEqual(len(p.fetch_artifacts(self.ctx, self.root)), 6)
                    self.assertEqual(download.call_count, 6)
                    self.assertEqual(bundle.call_count, 6)
                else:
                    with self.assertRaises(RuntimeError): p.fetch_artifacts(self.ctx, self.root)
                    download.assert_not_called()

    def test_download_checks_digest_and_does_not_forward_token(self):
        data = b'opaque artifact ZIP'
        url = 'https://example.blob.core.windows.net/signed?sig=test'
        redirect = urllib.error.HTTPError('api', 302, 'Found', {'Location': url}, None)
        artifact = {'id': 1, 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}
        for correct in [True, False]:
            opener = MagicMock()
            opener.open.return_value = io.BytesIO(data if correct else b'corrupt')
            with self.subTest(correct=correct), patch.object(p, 'api', side_effect=redirect), patch.object(p.urllib.request, 'build_opener', return_value=opener):
                if correct:
                    p.download(artifact, self.root / 'download.zip')
                else:
                    with self.assertRaises(RuntimeError): p.download(artifact, self.root / 'download.zip')
                opener.open.assert_called_once_with(url, timeout=180)
        for bad_url in ['http://example.com/file', 'https://user:secret@example.com/file']:
            redirect = urllib.error.HTTPError('api', 302, 'Found', {'Location': bad_url}, None)
            with patch.object(p, 'api', side_effect=redirect), patch.object(p.urllib.request, 'build_opener') as opener:
                with self.assertRaises(RuntimeError): p.download(artifact, self.root / 'download.zip')
                opener.assert_not_called()

    def test_workflow_security_contract(self):
        workflow = (ROOT / '.github/workflows/for-bgo.yml').read_text(encoding='utf-8')
        self.assertIn('workflow_dispatch:', workflow)
        triggers = workflow.split('on:\n', 1)[1].split('\njobs:', 1)[0]
        self.assertEqual(set(re.findall(r'^  ([a-z_]+):$', triggers, re.M)), {'push', 'workflow_dispatch'})
        self.assertNotIn('tags:', triggers)
        publisher = workflow.split('\n  publish:\n', 1)[1].split('\npermissions:', 1)[0]
        self.assertIn('needs: [validate-release, build]', publisher)
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.is_release == true", publisher)
        self.assertIn("needs.build.result == 'success'", publisher)
        self.assertNotIn('pnpm', publisher)
        self.assertEqual(workflow.count('run: python scripts/bgo_release.py publish'), 1)
        matrix = re.findall(r'- os: (\w+)\n\s+arch: (\w+)', workflow)
        self.assertEqual({os_name + '-' + arch for os_name, arch in matrix}, set(p.PLATFORMS))
        self.assertEqual(len(matrix), 6)
        for forbidden in ['workflow_run:', 'schedule:', 'force_replace:', 'ncipollo/release-action',
                          'dawidd6/action-download-artifact', 'RELEASE_TOKEN', 'purge-release-assets',
                          'move-tag', '${{ inputs.release_tag }}', '${{ inputs.release_name }}']:
            self.assertNotIn(forbidden, workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('contents: read', workflow)
        self.assertEqual(workflow.count('contents: write'), 1)
        self.assertIn('actions: read', workflow)
        self.assertIn('overwrite: true', workflow)
        self.assertIn('persist-credentials: false', workflow)
        self.assertIn('python scripts/bgo_release.py', workflow)
        self.assertFalse((ROOT / 'scripts/github-ci-artifacts.js').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
