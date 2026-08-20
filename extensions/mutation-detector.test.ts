import { describe, expect, it } from 'vitest';

import { classifyMutationCall } from './mutation-detector.js';

const bash = (command: string) => classifyMutationCall('bash', { command });

describe('classifyMutationCall', () => {
  it('classifies native edit and write as high-confidence native mutations', () => {
    expect(classifyMutationCall('edit', {})).toEqual({
      confidence: 'high',
      surface: 'native',
      signal: 'native-edit',
    });
    expect(classifyMutationCall('write', {})).toEqual({
      confidence: 'high',
      surface: 'native',
      signal: 'native-write',
    });
  });

  it('classifies non-bash tools as none', () => {
    expect(classifyMutationCall('read', { path: '/x' })).toEqual({ confidence: 'none' });
    expect(classifyMutationCall('grep', {})).toEqual({ confidence: 'none' });
    expect(classifyMutationCall('my_custom_tool', {})).toEqual({ confidence: 'none' });
    expect(classifyMutationCall('bash', {})).toEqual({ confidence: 'none' });
    expect(classifyMutationCall('bash', { command: '' })).toEqual({ confidence: 'none' });
  });
});

describe('bash file redirection', () => {
  it('treats plain and append file redirection as high-confidence writes', () => {
    expect(bash('echo hi > out.txt')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('echo hi >> log.txt')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('cat a b >| out')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('cmd &> both.log')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('cmd 2> err.log')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('cmd >& file')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('echo x 2>> err.log')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
  });

  it('never treats fd duplication as a file write', () => {
    expect(bash('echo hi 2>&1')).toEqual({ confidence: 'none' });
    expect(bash('echo hi 1>&2')).toEqual({ confidence: 'none' });
    expect(bash('echo hi >&1')).toEqual({ confidence: 'none' });
    expect(bash('cmd 3>&1')).toEqual({ confidence: 'none' });
    expect(bash('cmd 2>&1 && echo done')).toEqual({ confidence: 'none' });
  });

  it('never treats benign sinks as file writes', () => {
    expect(bash('cmd > /dev/null')).toEqual({ confidence: 'none' });
    expect(bash('cmd >> /dev/null 2>&1')).toEqual({ confidence: 'none' });
    expect(bash('cmd 2> /dev/stderr')).toEqual({ confidence: 'none' });
    expect(bash('cmd > /dev/stdout')).toEqual({ confidence: 'none' });
    expect(bash('cmd > /dev/fd/3')).toEqual({ confidence: 'none' });
  });

  it('ignores redirection-like text inside quotes, arithmetic and tests', () => {
    expect(bash('echo "a > b"')).toEqual({ confidence: 'none' });
    expect(bash("echo 'x > y' | cat")).toEqual({ confidence: 'none' });
    expect(bash('echo $((1 > 2))')).toEqual({ confidence: 'none' });
    expect(bash('[[ $a > $b ]] && echo cmp')).toEqual({ confidence: 'none' });
    expect(bash('echo $((4 << 2))')).toEqual({ confidence: 'none' });
  });

  it('still sees real redirects around quoted content and to quoted targets', () => {
    expect(bash('echo "a > b" > out.txt')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('echo x > "out file"')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash("echo x > 'out file'")).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('echo $((1 + 2)) > out.txt')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('echo hi 2>&1 > out.txt')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
  });

  it('ignores mutation-like text in shell comments', () => {
    expect(bash('ls # && touch x')).toEqual({ confidence: 'none' });
    expect(bash('printf ok # > out')).toEqual({ confidence: 'none' });
    expect(bash("echo '# > out'")).toEqual({ confidence: 'none' });
  });
});

describe('bash heredocs', () => {
  it('treats a redirect after a heredoc opener as a write', () => {
    expect(bash('cat <<EOF > out.txt')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('cat <<EOF\nbody text\nEOF')).toEqual({ confidence: 'none' });
  });

  it('ignores shell-looking or python-looking heredoc bodies', () => {
    expect(bash('cat <<EOF\ntouch f\necho x > y\nEOF')).toEqual({ confidence: 'none' });
    expect(bash("cat <<'EOF'\ntouch f\necho x > y\nEOF")).toEqual({ confidence: 'none' });
    expect(bash('cat <<"EOF"\ntouch f\necho x > y\nEOF')).toEqual({ confidence: 'none' });
    expect(bash("cat <<'PY'\npython -c 'import os; os.remove(\"x\")'\nPY")).toEqual({ confidence: 'none' });
    expect(bash('cat <<EOF\necho hi > out.txt\nEOF')).toEqual({ confidence: 'none' });
  });

  it('keeps a python heredoc body visible for python classification', () => {
    expect(bash("python <<'PY'\nfrom pathlib import Path\nPath('x').write_text('y')\nPY")).toMatchObject({
      confidence: 'high',
      surface: 'bash-python-inline',
      signal: 'python-write-api',
    });
    expect(bash('python <<PY\nprint(1)\nPY')).toEqual({ confidence: 'none' });
  });
});

describe('bash shell writers', () => {
  it('recognizes in-place editors', () => {
    expect(bash("sed -i 's/a/b/' f")).toMatchObject({ confidence: 'high', signal: 'shell-inplace' });
    expect(bash('sed -i.bak s/a/b/ f')).toMatchObject({ confidence: 'high', signal: 'shell-inplace' });
    expect(bash('sed --in-place s/a/b/ f')).toMatchObject({ confidence: 'high', signal: 'shell-inplace' });
    expect(bash("perl -pi -e 's/a/b/' f")).toMatchObject({ confidence: 'high', signal: 'shell-inplace' });
    expect(bash("perl -i.bak -pe 's/a/b/' f")).toMatchObject({ confidence: 'high', signal: 'shell-inplace' });
    expect(bash("awk -i inplace '{print $1}' f")).toMatchObject({ confidence: 'high', signal: 'shell-inplace' });
  });

  it('recognizes file-writer commands at command position', () => {
    expect(bash('echo x | tee out.txt')).toMatchObject({ confidence: 'high', signal: 'shell-writer' });
    expect(bash('patch -p1 < diff.patch')).toMatchObject({ confidence: 'high', signal: 'shell-writer' });
    expect(bash('git apply changes.patch')).toMatchObject({ confidence: 'high', signal: 'shell-writer' });
    expect(bash('truncate -s 0 log.txt')).toMatchObject({ confidence: 'high', signal: 'shell-writer' });
    expect(bash('touch marker')).toMatchObject({ confidence: 'high', signal: 'shell-writer' });
    expect(bash('sudo tee /etc/hosts')).toMatchObject({ confidence: 'high', signal: 'shell-writer' });
  });

  it('recognizes filesystem mutators at command position', () => {
    expect(bash('cp a b')).toMatchObject({ confidence: 'high', signal: 'shell-filesystem' });
    expect(bash('mv a b')).toMatchObject({ confidence: 'high', signal: 'shell-filesystem' });
    expect(bash('rm -rf build')).toMatchObject({ confidence: 'high', signal: 'shell-filesystem' });
    expect(bash('mkdir -p dist')).toMatchObject({ confidence: 'high', signal: 'shell-filesystem' });
    expect(bash('ln -s a b')).toMatchObject({ confidence: 'high', signal: 'shell-filesystem' });
    expect(bash('install -m 644 a b')).toMatchObject({ confidence: 'high', signal: 'shell-filesystem' });
    expect(bash('cd x && mv a b')).toMatchObject({ confidence: 'high', signal: 'shell-filesystem' });
  });

  it('recognizes dd writes and ignores dd to benign sinks', () => {
    expect(bash('dd if=/dev/zero of=out.bin bs=1M count=1')).toMatchObject({
      confidence: 'high',
      signal: 'shell-dd',
    });
    expect(bash('dd if=x of=/dev/null')).toEqual({ confidence: 'none' });
    expect(bash('dd if=x of=/dev/stdout')).toEqual({ confidence: 'none' });
  });

  it('recognizes destructive git worktree ops', () => {
    expect(bash('git reset --hard')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
    expect(bash('git reset --hard HEAD~1')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
    expect(bash('git reset --soft --hard')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
    expect(bash('git checkout -- .')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
    expect(bash('git checkout HEAD -- file.txt')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
    expect(bash('git checkout .')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
    expect(bash('git restore src/app.ts')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
    expect(bash('git clean -fd')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
  });

  it('leaves non-destructive git alone', () => {
    expect(bash('git checkout -b feature')).toEqual({ confidence: 'none' });
    expect(bash('git checkout main')).toEqual({ confidence: 'none' });
    expect(bash('git reset HEAD~1')).toEqual({ confidence: 'none' });
    expect(bash('git clean -n')).toEqual({ confidence: 'none' });
  });

  it('sees mutations inside then/do/else compound blocks', () => {
    expect(bash('if true; then sed -i s/a/b/ f; fi')).toMatchObject({ confidence: 'high', signal: 'shell-inplace' });
    expect(bash('while read x; do rm -rf $x; done')).toMatchObject({ confidence: 'high', signal: 'shell-filesystem' });
    expect(bash('if [ -f x ]; then echo hi > out.txt; fi')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash('if ok; then :; else git reset --hard; fi')).toMatchObject({ confidence: 'high', signal: 'shell-git-destructive' });
    expect(bash('if x; then python -c \'open("f","w")\'; fi')).toMatchObject({ confidence: 'high', signal: 'python-write-api' });
  });

  it('leaves unrecognized commands and lookalikes alone', () => {
    expect(bash('ls -la')).toEqual({ confidence: 'none' });
    expect(bash('grep -i pattern f')).toEqual({ confidence: 'none' });
    expect(bash('ls *.patch')).toEqual({ confidence: 'none' });
    expect(bash('ls | grep patch')).toEqual({ confidence: 'none' });
    expect(bash('npm install')).toEqual({ confidence: 'none' });
    expect(bash('git status')).toEqual({ confidence: 'none' });
    expect(bash('git log --stat')).toEqual({ confidence: 'none' });
    expect(bash('git diff')).toEqual({ confidence: 'none' });
    expect(bash('cat file.txt')).toEqual({ confidence: 'none' });
    expect(bash('x=cp; echo $x')).toEqual({ confidence: 'none' });
    expect(bash('which python')).toEqual({ confidence: 'none' });
  });
});

describe('bash inline python', () => {
  it('recognizes explicit write APIs as high confidence', () => {
    expect(bash("python -c \"open('/tmp/x','w').write('y')\"")).toMatchObject({
      confidence: 'high',
      surface: 'bash-python-inline',
      signal: 'python-write-api',
    });
    expect(bash("python3 -c 'open(\"f\", \"a\")'")).toMatchObject({ confidence: 'high', signal: 'python-write-api' });
    expect(bash("python -c 'open(\"f\", mode=\"x\")'")).toMatchObject({ confidence: 'high', signal: 'python-write-api' });
    expect(bash("python -c 'open(\"f\", \"r+\")'")).toMatchObject({ confidence: 'high', signal: 'python-write-api' });
    expect(bash("python -c 'import os; os.remove(\"/tmp/x\")'")).toMatchObject({
      confidence: 'high',
      signal: 'python-write-api',
    });
    expect(bash("python -c 'import os; os.makedirs(\"d\")'")).toMatchObject({
      confidence: 'high',
      signal: 'python-write-api',
    });
    expect(bash("python -c 'from pathlib import Path; Path(\"x\").write_text(\"y\")'")).toMatchObject({
      confidence: 'high',
      signal: 'python-write-api',
    });
    expect(bash("python -c 'import shutil; shutil.move(\"a\", \"b\")'")).toMatchObject({
      confidence: 'high',
      signal: 'python-write-api',
    });
    expect(bash("uv run python -c 'import shutil; shutil.copyfile(\"a\", \"b\")'")).toMatchObject({
      confidence: 'high',
      signal: 'python-write-api',
    });
    expect(bash("python -c 'import os; os.remove(\"x\")' > /dev/null 2>&1")).toMatchObject({
      confidence: 'high',
      signal: 'python-write-api',
    });
  });

  it('treats read-only inline python as none', () => {
    expect(bash("python -c 'print(\"hi\")'")).toEqual({ confidence: 'none' });
    expect(bash("python3 -c 'import json; print(json.dumps({}))'")).toEqual({ confidence: 'none' });
    expect(bash("python -c 'open(\"f\", \"r\").read()'")).toEqual({ confidence: 'none' });
  });

  it('treats opaque python forms as possible, never blocking', () => {
    expect(bash('python script.py')).toEqual({
      confidence: 'possible',
      surface: 'bash-python-opaque',
      signal: 'python-opaque',
    });
    expect(bash('python3 -m pytest')).toEqual({
      confidence: 'possible',
      surface: 'bash-python-opaque',
      signal: 'python-opaque',
    });
    expect(bash('pytest -q')).toEqual({
      confidence: 'possible',
      surface: 'bash-python-opaque',
      signal: 'python-opaque',
    });
    expect(bash('uv run python script.py')).toEqual({
      confidence: 'possible',
      surface: 'bash-python-opaque',
      signal: 'python-opaque',
    });
    expect(bash("python -c 'import subprocess; subprocess.run([\"touch\", \"x\"])'")).toEqual({
      confidence: 'possible',
      surface: 'bash-python-opaque',
      signal: 'python-opaque',
    });
    expect(bash("python -c 'exec(\"open(\\\"x\\\", \\\"w\\\")\")'")).toEqual({
      confidence: 'possible',
      surface: 'bash-python-opaque',
      signal: 'python-opaque',
    });
  });

  it('still catches a shell write elsewhere in a command with opaque python', () => {
    expect(bash('python script.py > out.txt')).toMatchObject({ confidence: 'high', signal: 'shell-redirect' });
    expect(bash("python -c 'print(\"hi\")' && echo x > out.txt")).toMatchObject({
      confidence: 'high',
      signal: 'shell-redirect',
    });
  });
});
