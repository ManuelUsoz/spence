import {
  lucideBrain,
  lucideFileText,
  lucideGlobe,
  lucideLoaderCircle,
  lucideMove,
  lucidePencil,
  lucideSearch,
  lucideTerminal,
  lucideTrash2,
  lucideWrench,
} from '@ng-icons/lucide';
import type { StepKind } from '../../../shared/sessions/sessions.rpc';
import type { TurnActivity } from './thread';

export const stepIconName = (kind: StepKind): string => {
  switch (kind) {
    case 'read':
      return 'lucideFileText';
    case 'edit':
      return 'lucidePencil';
    case 'delete':
      return 'lucideTrash2';
    case 'move':
      return 'lucideMove';
    case 'search':
      return 'lucideSearch';
    case 'execute':
      return 'lucideTerminal';
    case 'fetch':
      return 'lucideGlobe';
    case 'other':
      return 'lucideWrench';
  }
};

export const activityIconName = (activity: TurnActivity): string | null => {
  switch (activity) {
    case 'starting':
      return null;
    case 'thinking':
      return 'lucideBrain';
    case 'step':
      return null;
    case 'writing':
      return 'lucidePencil';
  }
};

export const threadIcons = {
  lucideBrain,
  lucideFileText,
  lucideGlobe,
  lucideLoaderCircle,
  lucideMove,
  lucidePencil,
  lucideSearch,
  lucideTerminal,
  lucideTrash2,
  lucideWrench,
};
