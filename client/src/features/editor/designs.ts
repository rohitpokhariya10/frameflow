import { createContext, useContext } from 'react';
import type { ProjectDocument } from '@frameflow/shared';
import type { DesignEntry } from '../../lib/persistence/designLibrary';

/**
 * The designs on this device besides the open one (lib/persistence/designLibrary.ts), from the editor session: list
 * them, switch to one, or open a new one in place of the open design, which is kept. Absent outside the app (tests that
 * render a part of the editor on its own).
 */
export type DesignSwitcher = { designs: () => DesignEntry[]; openDesign: (id: string) => void; openNewDesign: (document: ProjectDocument) => void };
export const DesignsContext = createContext<DesignSwitcher | undefined>(undefined);
export const useDesigns = () => useContext(DesignsContext);
