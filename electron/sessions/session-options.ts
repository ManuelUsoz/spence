import type {
  AvailableCommand,
  SessionConfigOption,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk/unstable';
import type { Effort, Model } from '../../src/shared/agents/agents.rpc';
import type { PermissionMode } from '../../src/shared/projects/projects.rpc';
import type { Command, SessionOptions } from '../../src/shared/sessions/sessions.rpc';
import type { EffortMap } from '../agents/catalog';
import type { PermissionModeMapping } from '../agents/permission-modes';

// ACP config options -> Spence's options (spec 5.3). Only the Model (`model` category) and the Effort
// (`thought_level`, through the Agent's `EffortMap`) are shown; every other option is hidden.

/** An option Spence shows, besides the Permission mode. */
export type ShownOption = 'model' | 'effort';

const CATEGORY: Readonly<Record<ShownOption, string>> = { model: 'model', effort: 'thought_level' };

const LEVELS: ReadonlyArray<Effort> = ['low', 'medium', 'high', 'max'];

/** The first select option of the category; ACP lists them in priority order. */
const find = (configOptions: ReadonlyArray<SessionConfigOption>, option: ShownOption) =>
  configOptions.find(
    (candidate) => candidate.type === 'select' && candidate.category === CATEGORY[option],
  );

/** The values a select option offers, groups flattened. */
const choicesOf = (option: SessionConfigOption): ReadonlyArray<SessionConfigSelectOption> => {
  if (option.type !== 'select') return [];
  return option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
};

/** Prefer ACP's mode config option, with legacy Mode IDs as a fallback. */
export const permissionSelection = (
  config: ReadonlyArray<SessionConfigOption>,
  legacy: ReadonlyArray<{ readonly id: string }>,
  mapping: PermissionModeMapping,
) => {
  const option = config.find(
    (candidate) => candidate.type === 'select' && candidate.category === 'mode',
  );
  for (const value of [mapping.agentMode, ...(mapping.alternatives ?? [])]) {
    if (option?.type === 'select' && choicesOf(option).some((choice) => choice.value === value)) {
      return { type: 'config' as const, configId: option.id, current: option.currentValue, value };
    }
    if (legacy.some((mode) => mode.id === value)) return { type: 'legacy' as const, value };
  }
  return undefined;
};

const levelOf = (map: EffortMap, value: string): Effort | undefined =>
  LEVELS.find((level) => map[level] === value);

/** The Agent's Model and Effort in Spence's vocabulary, with the Permission mode Spence keeps itself. */
export const foldOptions = (
  configOptions: ReadonlyArray<SessionConfigOption>,
  effortMap: EffortMap,
  permissionMode: PermissionMode,
): SessionOptions => {
  const model = find(configOptions, 'model');
  const effort = find(configOptions, 'effort');
  const modelChoices = model === undefined ? [] : choicesOf(model);
  const levels =
    effort === undefined
      ? []
      : LEVELS.filter((level) => choicesOf(effort).some((c) => c.value === effortMap[level]));
  const currentLevel =
    effort?.type === 'select' ? levelOf(effortMap, effort.currentValue) : undefined;
  return {
    ...(model?.type === 'select' && modelChoices.length > 0
      ? {
          model: {
            value: model.currentValue,
            choices: modelChoices.map((choice): Model => ({
              id: choice.value,
              name: choice.name,
              ...(typeof choice.description === 'string'
                ? { description: choice.description }
                : {}),
            })),
          },
        }
      : {}),
    ...(currentLevel === undefined ? {} : { effort: { value: currentLevel, choices: levels } }),
    permissionMode,
  };
};

/**
 * The config option and Agent value for a Spence value (a Model id, or an Effort level); none when the Agent does not
 * offer it in this session.
 */
export const agentValue = (
  configOptions: ReadonlyArray<SessionConfigOption>,
  effortMap: EffortMap,
  option: ShownOption,
  value: string,
): { readonly configId: string; readonly value: string } | undefined => {
  const config = find(configOptions, option);
  if (config === undefined) return undefined;
  const level = LEVELS.find((candidate) => candidate === value);
  const wanted = option === 'model' ? value : level === undefined ? undefined : effortMap[level];
  if (wanted === undefined || !choicesOf(config).some((choice) => choice.value === wanted)) {
    return undefined;
  }
  return { configId: config.id, value: wanted };
};

/**
 * What a new Session starts on (spec 5.3): the pinned Setting, else the last used, else the Agent default
 * (`undefined`). A pin the Agent no longer offers starts on the Agent default; the pin itself stays saved.
 */
export const chooseStart = <A extends string>(choice: {
  readonly pinned?: A;
  readonly last?: A;
  readonly offered: ReadonlyArray<string>;
}): A | undefined => {
  const wanted = choice.pinned ?? choice.last;
  return wanted !== undefined && choice.offered.includes(wanted) ? wanted : undefined;
};

/** The exact text selecting a Composer entry inserts, and the display name it shows. */
const invocationOf = (name: string): { name: string; invocation: string } => {
  if (name.startsWith('/') || name.startsWith('$')) {
    return { name: name.slice(1), invocation: name };
  }
  return { name, invocation: `/${name}` };
};

/**
 * The Agent's Composer entries. ACP advertises names and descriptions, not a kind: only an explicit adapter `_meta`
 * kind is reliable evidence of a Skill; everything else stays a Command. An adapter may also pin the exact
 * invocation (for example Codex's `$name`); otherwise selecting inserts the conventional `/name`.
 */
export const toCommands = (
  commands: ReadonlyArray<AvailableCommand>,
  ownerName: string,
): ReadonlyArray<Command> =>
  commands.map((command) => {
    const meta = command._meta ?? {};
    const metaKind = meta['kind'] ?? meta['type'];
    const kind =
      typeof metaKind === 'string' && metaKind.toLowerCase() === 'skill' ? 'skill' : 'command';
    const { name, invocation } = invocationOf(command.name);
    const metaInvocation = meta['invocation'];
    const exact =
      typeof metaInvocation === 'string' && metaInvocation.trim() !== ''
        ? metaInvocation
        : invocation;
    return {
      id: `${ownerName}:${command.name}`,
      name,
      invocation: exact,
      owner: { kind: 'agent', name: ownerName },
      kind,
      description: command.description,
      ...(command.input?.hint === undefined ? {} : { hint: command.input.hint }),
    };
  });
