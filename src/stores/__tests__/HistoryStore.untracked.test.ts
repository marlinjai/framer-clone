// runUntracked: a change the server owns (the project rename) must not become
// an undo step, while ordinary edits still do.
import { describe, it, expect } from 'vitest';
import HistoryStore from '../HistoryStore';
import ProjectModel from '@/models/ProjectModel';

function setup() {
  const project = ProjectModel.create({ id: 'site_1', metadata: { title: 'Old', description: '' }, pages: {} });
  const history = HistoryStore.create({});
  history.setTargetStore(project);
  return { project, history };
}

describe('HistoryStore.runUntracked', () => {
  it('a rename applied through runUntracked records no history entry', () => {
    const { project, history } = setup();
    history.runUntracked(() => project.updateMetadata({ title: 'New' }));
    expect(project.metadata.title).toBe('New');
    expect(history.history.length).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it('the same action outside runUntracked is recorded (the middleware is live)', () => {
    const { project, history } = setup();
    project.updateMetadata({ description: 'edited' });
    expect(history.history.length).toBe(1);
  });

  it('returns the callback value', () => {
    const { history } = setup();
    expect(history.runUntracked(() => 42)).toBe(42);
  });
});
