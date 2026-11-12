// Site branches: the history remembers that an "update from main" step was undone. The branch still counts as up
// to date with main then, so merging it would take main's changes out of main; the top bar says so while this holds.
import { describe, expect, it } from 'vitest';
import HistoryStore from '../HistoryStore';
import ProjectModel from '@/models/ProjectModel';
import { UPDATE_FROM_MAIN_LABEL } from '@/lib/sites/branchLabels';

function setup() {
  const project = ProjectModel.create({ id: 'branch_1', metadata: { title: 'Bakery', description: '' }, pages: {} });
  const history = HistoryStore.create({});
  history.setTargetStore(project);
  return { project, history };
}

describe('HistoryStore.undoneUpdateId', () => {
  it('forward: undoing the update step sets it, redoing that step clears it', () => {
    const { project, history } = setup();
    history.applyRemote(UPDATE_FROM_MAIN_LABEL, () => project.updateMetadata({ description: 'from main' }));
    expect(history.undoneUpdateId).toBeUndefined();
    history.undo();
    expect(project.metadata.description).toBe('');
    expect(history.undoneUpdateId).toBe(history.history[0].id);
    history.redo();
    expect(project.metadata.description).toBe('from main');
    expect(history.undoneUpdateId).toBeUndefined();
  });

  it('stays set after a later edit has dropped the step from the redo tail: the changes are still out', () => {
    const { project, history } = setup();
    history.applyRemote(UPDATE_FROM_MAIN_LABEL, () => project.updateMetadata({ description: 'from main' }));
    history.undo();
    project.updateMetadata({ title: 'Bakery, renamed' });
    expect(history.canRedo).toBe(false);
    expect(history.undoneUpdateId).toBeDefined();
    // Undoing and redoing the person's own edit changes nothing about it.
    history.undo();
    history.redo();
    expect(history.undoneUpdateId).toBeDefined();
    history.clear();
    expect(history.undoneUpdateId).toBeUndefined();
  });

  it('is not set by undoing any other step, a person\'s own or another adopted one', () => {
    const { project, history } = setup();
    project.updateMetadata({ description: 'mine' });
    history.applyRemote('Ana: edited the site', () => project.updateMetadata({ title: 'Theirs' }));
    // A person's own edit that happens to carry the same name is not an adopted update.
    history.applyRemote(UPDATE_FROM_MAIN_LABEL, () => project.updateMetadata({ description: 'replayed' }), false);
    history.undo();
    history.undo();
    history.undo();
    expect(history.undoneUpdateId).toBeUndefined();
  });
});
