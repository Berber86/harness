import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deleteSkill,
  loadSkills,
  matchSkillInvocation,
  saveSkill,
} from '../src/index.js';

test('loadSkills reads repository skills/ directory and supports slash matching', async () => {
  const skillsDir = path.resolve(process.cwd(), 'skills');
  const skills = await loadSkills(skillsDir);
  const names = skills.map((s) => s.name);

  assert.ok(names.includes('reframe'));
  assert.ok(names.includes('sharpen'));
  assert.ok(names.includes('in-your-own-words'));
  assert.ok(names.includes('blast-radius'));

  const reframe = skills.find((s) => s.name === 'reframe')!;
  assert.equal(reframe.mode, 'plan');
  assert.equal(reframe.disableModelInvocation, true);
  assert.match(reframe.instructions, /8–12 ключевых терминов/);

  const invocation = matchSkillInvocation('/reframe хочу сделать видеоредактор', skills);
  assert.equal(invocation?.skill.name, 'reframe');
  assert.equal(invocation?.remainder, 'хочу сделать видеоредактор');

  assert.equal(matchSkillInvocation('/unknown тест', skills), null);
});

test('saveSkill, flat .md fallback, and deleteSkill work safely inside skillsDir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-skills-'));
  try {
    await writeFile(path.join(dir, 'quick.md'), '---\nname: quick\ntitle: "Быстрый"\nmode: act\n---\nДелай быстро.\n', 'utf8');
    const saved = await saveSkill(dir, {
      name: 'my-skill',
      title: 'Мой навык',
      icon: '🧪',
      description: 'Тестовый навык',
      mode: 'plan',
      instructions: 'Разбери задачу на 3 шага.',
    });
    assert.equal(saved.name, 'my-skill');
    assert.equal(saved.mode, 'plan');

    const loaded = await loadSkills(dir);
    assert.deepEqual(loaded.map((s) => s.name).sort(), ['my-skill', 'quick']);

    await assert.rejects(
      () => saveSkill(dir, { name: '../escape', instructions: 'bad' }),
      /Имя навыка/,
    );

    assert.equal(await deleteSkill(dir, 'my-skill'), true);
    const afterDelete = await loadSkills(dir);
    assert.deepEqual(afterDelete.map((s) => s.name), ['quick']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
