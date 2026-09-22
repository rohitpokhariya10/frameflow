import { createAction } from '@reduxjs/toolkit';
import type { ProjectDocument } from '@frameflow/shared';

/** Project boundary, deliberately outside document undo history. */
export const projectReset = createAction<ProjectDocument>('project/reset');
