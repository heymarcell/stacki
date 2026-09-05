// The evaluation harness's containment, checked.
//
//   node test/eval-containment.js
//
// WHY THIS FILE EXISTS. `scripts/eval/heldout/host.js` decides what environment
// a real, autonomous agent host is launched with. Nothing in this repository
// tested it, and it has now regressed THREE TIMES in one campaign, each time by
// the same move — someone narrowed the strip to be safer and took something
// load-bearing with it:
//
//   1. the strip removed the HOST'S OWN model-API login, so on any machine
//      without an interactive ~/.claude every trial died at startup and was
//      graded as a Stacki failure;
//   2. the repair kept the static cloud credentials and still removed the ones
//      that SOURCE a credential — AWS_WEB_IDENTITY_TOKEN_FILE and friends — so
//      it failed on exactly the containerised runners it was meant to fix;
//   3. the repair after that removed `STACKI_MCP_TOKEN`, the bearer the trial
//      mints for the sandbox it just built, so the host could not authenticate
//      to the Stacki it was pointed at and, again, every trial failed as Stacki.
//
// Every one of those is invisible on the machine it was written on and fatal
// somewhere else, and none of them is visible in a review of the diff — they
// are visible only by BUILDING THE ENVIRONMENT AND LOOKING AT IT. That is all
// this file does.
//
// NO AGENT HOST RUNS HERE. A containment proof that needs a model, a packaged
// app and twenty minutes is a proof nobody runs, which is how this got to three
// regressions. This builds environments, reads them, and asks `sh` and `git`
// the two questions that cannot be answered from a variable.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { containedEnv, runHost, CREDENTIAL_VARS } = require('../scripts/eval/heldout/host.js');
const { hostRan, isolationVerdict } = require('../scripts/eval/heldout/run.js');
const { startPackagedApp } = require('./support/packagedApp.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => JSON.stringify(v ?? null);

// ---------------------------------------------------------------------------
// THE TABLES, WRITTEN OUT HERE RATHER THAN IMPORTED.
//
// This is the whole point of the file. If these names were read out of host.js,
// then narrowing host.js would narrow the test with it and every regression
// above would still pass. They are typed here so the NEXT narrowing has to
// delete an assertion by hand, in a file whose header says why it must not.

/** The credentials that reach GitHub. None of these may survive, ever. */
const MUST_NOT_SURVIVE = [
  'GITHUB_MCP_PAT',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_ENTERPRISE_TOKEN',
];

/**
 * The host's own logins, which are not the trial's to lose.
 *
 * These reach Anthropic, AWS or Google — never GitHub — and stripping them does
 * not contain a trial, it stops `claude` starting. The failure is ASYMMETRIC:
 * it passes on a laptop with an interactive login and kills every trial on a
 * runner, where the grader scores the corpse as a product failure.
 *
 * Split in two because the second half is the one that got lost: a variable
 * that NAMES A FILE OR AN ENDPOINT holding the credential is as load-bearing as
 * one that holds it. IRSA on EKS, a task role on ECS, OIDC in GitHub Actions
 * and a gcloud token on Vertex all authenticate through the sourcing spellings
 * and none through the static ones.
 */
const MUST_SURVIVE_STATIC = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
];
const MUST_SURVIVE_SOURCING = [
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
];

/**
 * Names nothing has enumerated, which the shape rule exists for.
 *
 * A trial is an autonomous agent with a shell; the credentials it might find on
 * a developer's machine are not a list anybody can keep current, so the rule is
 * a shape. These are decoys planted in `process.env` for the duration.
 */
const DECOY_SHAPED = [
  'ACME_API_KEY',
  'SOMETHING_SECRET',
  'DB_PASSWORD',
  'VAULT_CREDENTIAL',
  'REGISTRY_AUTH',
  'SIGNING_KEY',
];

/** The bearer the trial mints for the loopback Stacki it just started. */
const TRIAL_TOKEN = 'STACKI_MCP_TOKEN';

// ---------------------------------------------------------------------------

// EVERY DIRECTORY THIS CHAIN MAKES IN os.tmpdir(), not the two the containment
// makes. A userData a failed start left behind has no other reference in the
// world — the caller got a throw instead of the object that names it — so it
// belongs in this sweep as much as the fake `gh` does.
const TMP_OURS = /^stacki-(fake-gh|trial-ghconfig|packaged-userdata|standin|eval-containment)-/;
const tmpResidue = () => fs.readdirSync(os.tmpdir()).filter((n) => TMP_OURS.test(n));

/** Set a name in this process's environment, and hand back how to put it back. */
function planted(values) {
  const before = new Map(Object.keys(values).map((n) => [n, process.env[n]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, was] of before) {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
  };
}

const sentinel = (name) => `sentinel-value-for-${name}`;

(async () => {
  const tmpBefore = tmpResidue();

  // --- WHAT A CONTAINED CHILD IS AND IS NOT GIVEN.
  //
  // Everything the tables name is planted in this process's environment first,
  // so the answers are about the strip rather than about which variables this
  // particular machine happens to have.
  {
    const restore = planted(
      Object.fromEntries(
        [...MUST_NOT_SURVIVE, ...MUST_SURVIVE_STATIC, ...MUST_SURVIVE_SOURCING, ...DECOY_SHAPED, TRIAL_TOKEN].map(
          (n) => [n, sentinel(n)]
        )
      )
    );
    let contained = null;
    try {
      contained = containedEnv({ [TRIAL_TOKEN]: 'the-token-this-trial-minted' });
      const env = contained.env;

      // --- THE FIVE THAT REACH GITHUB.
      for (const name of MUST_NOT_SURVIVE) {
        check(`${name} is absent from the child environment`, env[name] === undefined, short(env[name] && '(set)'));
      }
      check(
        'and the exported list still names all five',
        MUST_NOT_SURVIVE.every((n) => CREDENTIAL_VARS.includes(n)),
        short(CREDENTIAL_VARS)
      );

      // --- ANYTHING ELSE SHAPED LIKE A CREDENTIAL.
      for (const name of DECOY_SHAPED) {
        check(`${name} is absent, by shape rather than by name`, env[name] === undefined, short(env[name] && '(set)'));
      }
      check(
        'and the removals are recorded by name in the run',
        DECOY_SHAPED.every((n) => contained.assertions.credentialsStrippedByShape.includes(n)),
        short(contained.assertions.credentialsStrippedByShape)
      );
      check(
        'and no value was recorded anywhere in the assertions',
        !JSON.stringify(contained.assertions).includes('sentinel-value-for-'),
        'a containment block that printed what it removed would be the leak it prevents'
      );

      // --- THE HOST'S OWN LOGINS. Regressions 1 and 2.
      for (const name of MUST_SURVIVE_STATIC) {
        check(`${name} survives — it reaches Anthropic/AWS/Google, not GitHub`, env[name] === sentinel(name), short(env[name]));
      }
      for (const name of MUST_SURVIVE_SOURCING) {
        check(
          `${name} survives — a variable that SOURCES a credential is a login too`,
          env[name] === sentinel(name),
          short(env[name])
        );
      }

      // --- THE TRIAL'S OWN TOKEN. Regression 3.
      check(
        `${TRIAL_TOKEN} passed through the env channel survives`,
        env[TRIAL_TOKEN] === 'the-token-this-trial-minted',
        short(env[TRIAL_TOKEN])
      );
      check(
        '  and it is the CALLER’s value, not the ambient one',
        env[TRIAL_TOKEN] !== sentinel(TRIAL_TOKEN),
        short(env[TRIAL_TOKEN])
      );
      check(
        '  and the exemption is recorded by name',
        contained.assertions.envChannelExempt.includes(TRIAL_TOKEN),
        short(contained.assertions.envChannelExempt)
      );

      // --- THE TWO QUESTIONS A VARIABLE CANNOT ANSWER, asked of the programs
      //     that would actually answer them for the child.
      const resolved = execFileSync('/bin/sh', ['-c', 'command -v gh'], { env, encoding: 'utf8' }).trim();
      check('`command -v gh` under that environment is the fake', resolved === contained.fake.bin, `${resolved} !== ${contained.fake.bin}`);
      check(
        '  and the fake is what the assertions claim it is',
        contained.assertions.ghResolvesTo === contained.fake.bin,
        short(contained.assertions.ghResolvesTo)
      );
      let helper = null;
      try {
        helper = execFileSync('git', ['config', '--get', 'credential.helper'], { env, encoding: 'utf8' }).trim();
      } catch {
        // git exits 1 when the key is unset, which is the answer we want.
        helper = '';
      }
      check('`git config --get credential.helper` is empty', helper === '', short(helper));
      check('  and the run records that it asked', contained.assertions.gitCredentialHelperDisabled === true, short(contained.assertions.gitCredentialHelperDisabled));
      check(
        '  and git still has an identity, so a commit inside a trial works',
        execFileSync('git', ['config', '--get', 'user.email'], { env, encoding: 'utf8' }).trim() === 'trial@stacki.invalid',
        'a containment that broke committing would be found by a failing trial, not by a security review'
      );
    } finally {
      if (contained) contained.cleanup();
      restore();
    }
  }

  // --- THE AMBIENT ONE IS STILL NOT THE TRIAL'S.
  //
  // The exemption is keyed to what the CALLER passed, not to the spelling. A
  // developer who exports STACKI_MCP_TOKEN for their own use must not have it
  // handed to an autonomous agent just because a harness elsewhere passes a
  // variable of that name.
  {
    const restore = planted({ [TRIAL_TOKEN]: sentinel(TRIAL_TOKEN) });
    const contained = containedEnv({});
    try {
      check(
        `an ambient ${TRIAL_TOKEN} the caller did not pass is still stripped`,
        contained.env[TRIAL_TOKEN] === undefined,
        short(contained.env[TRIAL_TOKEN])
      );
      check('  and nothing was exempted', contained.assertions.envChannelExempt.length === 0, short(contained.assertions.envChannelExempt));
    } finally {
      contained.cleanup();
      restore();
    }
  }

  // --- THE ENV CHANNEL IS NOT A BYPASS.
  //
  // Exempting a caller-supplied name from the SHAPE rule is a heuristic
  // declining to veto a deliberate act. Exempting one from the GitHub list
  // would be the harness handing out the credential it exists to withhold, so
  // that is refused — and refused loudly, because a caller that asked for it
  // needs to know it did not happen.
  {
    const restore = planted({ GITHUB_TOKEN: sentinel('GITHUB_TOKEN') });
    for (const name of MUST_NOT_SURVIVE) {
      let threw = null;
      let leaked = null;
      try {
        const c = containedEnv({ [name]: 'a-real-looking-pat' });
        leaked = c.env[name];
        c.cleanup();
      } catch (err) {
        threw = String(err?.message || err);
      }
      check(`${name} through the env channel is refused, not honoured`, threw !== null && leaked === null, short({ threw, leaked }));
      check(`  and the refusal names it`, threw !== null && threw.includes(name), short(threw));
    }
    restore();
  }

  // --- WHAT THE RUN RECORDS ABOUT THE REST OF THE TRIAL.
  //
  // `containedEnv` builds ONE process's environment, and a trial is at least
  // two: the agent host and the packaged Stacki that actually runs
  // `git.publish`. The default answer is the honest one — that the siblings
  // were not contained — so a runner that forgets writes the omission into its
  // own results file.
  {
    const alone = containedEnv({});
    const both = containedEnv({}, { siblingsContained: true });
    try {
      check('by default the residual says the other processes were not contained', /OTHER PROCESSES IN THIS TRIAL/.test(alone.assertions.residual), alone.assertions.residual);
      check('  and the field says so machine-readably', alone.assertions.siblingsContained === false, short(alone.assertions.siblingsContained));
      check('when the siblings ARE contained the residual drops that entry', !/OTHER PROCESSES IN THIS TRIAL/.test(both.assertions.residual), both.assertions.residual);
      check('  and the field says so', both.assertions.siblingsContained === true, short(both.assertions.siblingsContained));
      // The residuals that are still true whatever else was contained.
      for (const phrase of ['gh by absolute path', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'HOME is not overridden']) {
        check(`  and still names the residual about ${phrase}`, both.assertions.residual.includes(phrase), both.assertions.residual);
      }
    } finally {
      alone.cleanup();
      both.cleanup();
    }
  }

  // --- THE PACKAGED LAUNCHER TAKES THE SAME ENVIRONMENT, PROVED BY LAUNCHING.
  //
  // For a whole round `containedEnv` was exported with no callers at all, so
  // the process that actually runs `git.publish` held the developer's real `gh`
  // and real token while the results file recorded a containment. The agent's
  // `ghCallsDuringTrial` proved what went through the AGENT's gh and nothing
  // whatever about the app's.
  //
  // READ OUT OF THE CHILD, not out of the source. A stand-in bundle takes the
  // place of Stacki: it writes its own environment down and exits. That is
  // enough to answer the only question here — what environment does
  // `startPackagedApp` hand the binary — and it costs half a second instead of
  // a build and a minute. It also exercises the failed-start path, where the
  // containment's teardown is reachable only through a `catch`.
  {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-standin-bundle-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-standin-project-'));
    const dumps = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-standin-dumps-'));
    try {
      // `startPackagedApp` refuses a handed-over project without dependencies,
      // which is a real check and is left alone; this is the cheapest thing
      // that satisfies it.
      fs.mkdirSync(path.join(proj, 'node_modules', 'astro'), { recursive: true });
      const macos = path.join(bundle, 'Contents', 'MacOS');
      fs.mkdirSync(macos, { recursive: true });
      // Writes its environment, NUL-separated so no value can be confused with
      // a separator, and exits at once — so the token wait ends on its first
      // poll rather than after eighty seconds.
      fs.writeFileSync(
        path.join(macos, 'Stacki'),
        `#!/bin/sh\n/usr/bin/env -0 > "$STACKI_STANDIN_DUMP"\nexit 0\n`,
        { mode: 0o755 }
      );

      // `contained: null` means DO NOT PASS THE OPTION AT ALL, which is the
      // only way to test the default. Passing `contained: false` explicitly
      // would leave "someone made it default-on" invisible — and default-on is
      // the change that would silently alter what every ordinary packaged suite
      // measures, so it is exactly what needs a failing test.
      const launch = async (contained, dumpName) => {
        const dump = path.join(dumps, dumpName);
        const restore = planted({ STACKI_STANDIN_DUMP: dump, GITHUB_TOKEN: sentinel('GITHUB_TOKEN') });
        let threw = null;
        try {
          const opts = { project: proj, app: bundle, portFrom: 46310 };
          if (contained !== null) opts.contained = contained;
          await startPackagedApp(opts);
        } catch (err) {
          threw = String(err?.message || err);
        } finally {
          restore();
        }
        const text = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
        const seen = new Map(
          text
            .split('\0')
            .filter(Boolean)
            .map((row) => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)])
        );
        return { threw, seen };
      };

      const off = await launch(null, 'uncontained.env');
      check('a packaged launch that says nothing about containment starts the binary', off.seen.size > 0, off.threw);
      check(
        '  and BY DEFAULT keeps the developer environment — containment is opt-in',
        off.seen.get('GITHUB_TOKEN') === sentinel('GITHUB_TOKEN'),
        'default-on would silently change what eight existing packaged suites measure: CI=1, a throwaway git identity with no credential helper, and a shadowed gh'
      );
      check(
        '  and by default shadows nothing on PATH',
        !/stacki-fake-gh-/.test(String(off.seen.get('PATH'))),
        short(String(off.seen.get('PATH')).split(path.delimiter)[0])
      );
      check('  and still passes the app its own variables', off.seen.get('STACKI_HIDDEN_WINDOW') === '1', short(off.seen.get('STACKI_HIDDEN_WINDOW')));

      const on = await launch(true, 'contained.env');
      check('a contained packaged launch really did start the binary', on.seen.size > 0, on.threw);
      for (const name of MUST_NOT_SURVIVE) {
        check(`  and the APP's environment has no ${name}`, on.seen.get(name) === undefined, short(on.seen.get(name) && '(set)'));
      }
      check(
        '  and the APP resolves gh to a fake, not the developer’s',
        /stacki-fake-gh-/.test(String(on.seen.get('PATH')).split(path.delimiter)[0] || ''),
        short(String(on.seen.get('PATH')).split(path.delimiter)[0])
      );
      check('  and the APP has no credential helper', /stacki-trial-ghconfig-/.test(String(on.seen.get('GIT_CONFIG_GLOBAL'))), short(on.seen.get('GIT_CONFIG_GLOBAL')));
      check('  and still gets its own variables through the env channel', on.seen.get('STACKI_HIDDEN_WINDOW') === '1', short(on.seen.get('STACKI_HIDDEN_WINDOW')));
      check('  and gets the automation marker it must match', typeof on.seen.get('STACKI_AUTOMATION_MARKER') === 'string', short(on.seen.get('STACKI_AUTOMATION_MARKER')));
      check('a start that fails still throws rather than hanging', /did not start its MCP server/.test(String(on.threw)), short(on.threw));

      // AND THE EVALUATION RUNNER ACTUALLY ASKS FOR IT.
      //
      // SAID PLAINLY: this pair is a source check, and a source check is the
      // weakest thing in this file. The behavioural version of it is a whole
      // trial — a corpus download, a built bundle, a real model — which is the
      // kind of proof that does not get run, and not running is how the
      // containment reached three regressions. The rest of this block launches
      // a binary and reads its environment; this cannot, so it says what it is
      // rather than dressing up as more.
      // WITH THE PROSE REMOVED FIRST. The first draft of this matched
      // `contained: true` inside the comment that explains why the option is
      // passed — so deleting the option itself left the check green. A source
      // check that reads its own documentation is worse than no check.
      const runner = fs
        .readFileSync(path.join(__dirname, '..', 'scripts', 'eval', 'heldout', 'run.js'), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      check(
        'the evaluation runner opts the app in (source check)',
        /contained: true/.test(runner),
        'a trial that does not is a contained agent asking an uncontained app to publish'
      );
      check(
        '  and tells runHost so, so the recorded residual is truthful (source check)',
        /siblingsContained: true/.test(runner),
        'otherwise the results file goes on saying the app was not contained when it was'
      );
    } finally {
      for (const dir of [bundle, proj, dumps]) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- A HOST THAT NEVER STARTS.
  //
  // Every count in that answer is zero because nothing happened. Grading those
  // zeros scores a harness failure as a product failure, and deriving isolation
  // from them reports a purity violation that never occurred — which is exactly
  // what shipped. The spawn is made to fail deterministically by pointing the
  // child's PATH at nothing; no `claude` is involved even on a machine that has
  // one installed.
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-eval-containment-ws-'));
    try {
      const host = await runHost({
        workspace: ws,
        url: 'http://127.0.0.1:1/mcp',
        token: 'not-used',
        prompt: 'this prompt is never delivered anywhere',
        mode: 'mcp-only',
        // PATH is rebuilt by the containment from this, with the fake gh
        // prepended — so `gh` still resolves and `claude` cannot.
        env: { PATH: path.join(ws, 'no-binaries-here') },
      });

      check('a spawn that never starts still settles', host && typeof host === 'object', short(host && Object.keys(host)));
      check('  and is not ok', host.ok === false, short(host.ok));
      check('  and carries the reason', /ENOENT|spawn/i.test(String(host.error)), short(host.error));
      check('  and counts nothing', host.builtinToolCalls === 0 && host.mcpToolCalls === 0, short({ b: host.builtinToolCalls, m: host.mcpToolCalls }));
      check('  and still records what the child would have been given', typeof host.containment?.ghResolvesTo === 'string', short(host.containment?.ghResolvesTo));
      check('  and reports the fake gh saw nothing', Array.isArray(host.containment?.ghCallsDuringTrial) && host.containment.ghCallsDuringTrial.length === 0, short(host.containment?.ghCallsDuringTrial));

      // THE TWO DERIVED ANSWERS, asked directly.
      check('a host that never ran is NOT graded', hostRan(host) === false, short(hostRan(host)));
      check(
        '  and is NOT counted as an isolation violation',
        isolationVerdict({ mode: 'mcp-only', host }) === null,
        short(isolationVerdict({ mode: 'mcp-only', host }))
      );
      // And the controls, so `null` is not simply what this function always says.
      check(
        '  while a real mcp-only run with no built-in calls DOES hold',
        isolationVerdict({ mode: 'mcp-only', host: { ok: true, builtinToolCalls: 0 } }) === true,
        short(isolationVerdict({ mode: 'mcp-only', host: { ok: true, builtinToolCalls: 0 } }))
      );
      check(
        '  and a real mcp-only run that used a built-in does NOT',
        isolationVerdict({ mode: 'mcp-only', host: { ok: true, builtinToolCalls: 3 } }) === false,
        short(isolationVerdict({ mode: 'mcp-only', host: { ok: true, builtinToolCalls: 3 } }))
      );
      check(
        '  and a failed-but-real run is still graded',
        hostRan({ ok: false, error: null, builtinToolCalls: 0 }) === true,
        'ok:false with no error is a host that ran and did badly, which is a result'
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  // --- AND NOTHING IS LEFT BEHIND.
  //
  // Every path above includes at least one REFUSAL, which is where this leaked
  // before: `cleanup()` lived only on the success path, so a containment that
  // declined to launch left its fake `gh` and its GH_CONFIG_DIR in os.tmpdir()
  // every time.
  {
    const after = tmpResidue();
    const left = after.filter((n) => !tmpBefore.includes(n));
    check('nothing this file created is left in os.tmpdir()', left.length === 0, short(left));
  }

  if (failures.length) {
    console.error(`eval-containment: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(
    `eval-containment: ${checked} passed  [GitHub credentials and credential-shaped names are gone, the host's own logins and the trial's own token survive, gh is the fake, and a host that never starts is not graded]`
  );
})().catch((err) => {
  console.error('eval-containment: threw\n', err?.stack || err);
  process.exit(1);
});
