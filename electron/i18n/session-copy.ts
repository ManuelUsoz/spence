import type { Locale } from './locale';

export interface HandoffCopy {
  readonly isolatedUnsupported: (agentName: string) => string;
  readonly isolatedUnavailable: (agentName: string) => string;
  readonly isolatedToolCall: (agentName: string) => string;
  readonly isolatedEmpty: (agentName: string) => string;
  readonly isolatedFailed: (agentName: string) => string;
  readonly modelNotOffered: (requestedModel: string, targetName: string) => string;
  readonly modelPrefilledDefault: (
    targetName: string,
    desiredModel: string,
    configuredDefault: string,
  ) => string;
  readonly modelNoValidDefault: (targetName: string, desiredModel: string) => string;
  readonly effortUnavailable: (targetName: string) => string;
  readonly askModeUnavailable: (targetName: string) => string;
  readonly diskStateEdits: string;
  readonly acknowledged: string;
  readonly requestedPermission: (targetName: string) => string;
  readonly ranUnexpectedSteps: (targetName: string) => string;
  readonly startupCancelled: string;
  readonly didNotAcknowledge: (targetName: string) => string;
}

export interface CrossProjectCopy {
  readonly question: (fromProject: string, toProject: string) => string;
  readonly allowOnce: string;
  readonly allowAlways: string;
  readonly deny: string;
  readonly sentNotice: (sessionTitle: string, projectName: string) => string;
}

export interface CrossDeviceCopy {
  /** The Step (and Permission request) of an Agent sending to a Session on another Device. */
  readonly sendStep: (sessionTitle: string, deviceName: string) => string;
  /** The Step (and Permission request) of an Agent starting a Session in a Project on another Device. */
  readonly startStep: (projectName: string, deviceName: string) => string;
  readonly allowOnce: string;
  readonly deny: string;
}

export interface SessionCopy {
  readonly verifyAgain: string;
  readonly memoryLostNoticeTitle: string;
  /** A Worker did not accept Stop, so it may still be running. */
  readonly workerStopFailed: (workerTitle: string) => string;
  readonly crossProject: CrossProjectCopy;
  readonly crossDevice: CrossDeviceCopy;
  readonly handoff: HandoffCopy;
}

const EN: SessionCopy = {
  verifyAgain: 'Verify again',
  memoryLostNoticeTitle: "Earlier Messages weren't sent to this fresh context",
  workerStopFailed: (workerTitle) =>
    `Couldn't stop Worker "${workerTitle}"; it may still be running`,
  crossProject: {
    question: (fromProject, toProject) => `Allow ${fromProject} to message ${toProject}?`,
    allowOnce: 'Allow once',
    allowAlways: 'Always allow',
    deny: 'Deny',
    sentNotice: (sessionTitle, projectName) =>
      `Sent a message to ${sessionTitle} in ${projectName}`,
  },
  crossDevice: {
    sendStep: (sessionTitle, deviceName) => `Send a message to ${sessionTitle} on ${deviceName}`,
    startStep: (projectName, deviceName) => `Start a Session in ${projectName} on ${deviceName}`,
    allowOnce: 'Allow once',
    deny: 'Deny',
  },
  handoff: {
    isolatedUnsupported: (agentName) =>
      `${agentName} does not support isolated tool-free summary drafting.`,
    isolatedUnavailable: (agentName) =>
      `${agentName} is currently unavailable; using Transcript extract.`,
    isolatedToolCall: (agentName) =>
      `${agentName} attempted a tool call during isolated summary; using Transcript extract.`,
    isolatedEmpty: (agentName) =>
      `${agentName} returned an empty isolated summary; using Transcript extract.`,
    isolatedFailed: (agentName) =>
      `${agentName} failed during isolated summary; using Transcript extract.`,
    modelNotOffered: (requestedModel, targetName) =>
      `Model "${requestedModel}" is not offered by ${targetName}.`,
    modelPrefilledDefault: (targetName, desiredModel, configuredDefault) =>
      `${targetName} does not offer "${desiredModel}"; prefilled default "${configuredDefault}" instead of silently substituting.`,
    modelNoValidDefault: (targetName, desiredModel) =>
      `${targetName} does not offer "${desiredModel}" and has no valid default Model; select a Model below.`,
    effortUnavailable: (targetName) => `Effort unavailable on ${targetName}.`,
    askModeUnavailable: (targetName) =>
      `Ask mode is unavailable on ${targetName}; Auto will be used.`,
    diskStateEdits:
      'Destination made file edits before the handoff failed; on-disk changes remain visible.',
    acknowledged: 'Handoff acknowledged.',
    requestedPermission: (targetName) =>
      `${targetName} requested tool permission instead of acknowledging the handoff.`,
    ranUnexpectedSteps: (targetName) =>
      `${targetName} ran unexpected tool steps instead of acknowledging the handoff.`,
    startupCancelled: 'Handoff startup was cancelled or stopped.',
    didNotAcknowledge: (targetName) => `${targetName} did not cleanly acknowledge the handoff.`,
  },
};

const ES: SessionCopy = {
  verifyAgain: 'Volver a verificar',
  memoryLostNoticeTitle: 'Los Mensajes anteriores no se enviaron a este contexto nuevo',
  workerStopFailed: (workerTitle) =>
    `No se pudo detener el Worker "${workerTitle}"; puede seguir en ejecución`,
  crossProject: {
    question: (fromProject, toProject) =>
      `¿Permitir que ${fromProject} envíe mensajes a ${toProject}?`,
    allowOnce: 'Permitir una vez',
    allowAlways: 'Permitir siempre',
    deny: 'Denegar',
    sentNotice: (sessionTitle, projectName) =>
      `Mensaje enviado a ${sessionTitle} en ${projectName}`,
  },
  crossDevice: {
    sendStep: (sessionTitle, deviceName) => `Enviar un mensaje a ${sessionTitle} en ${deviceName}`,
    startStep: (projectName, deviceName) => `Iniciar una Sesión en ${projectName} en ${deviceName}`,
    allowOnce: 'Permitir una vez',
    deny: 'Denegar',
  },
  handoff: {
    isolatedUnsupported: (agentName) =>
      `${agentName} no admite la redacción de resumen aislado sin herramientas.`,
    isolatedUnavailable: (agentName) =>
      `${agentName} no está disponible en este momento; usando extracto de la Transcripción.`,
    isolatedToolCall: (agentName) =>
      `${agentName} intentó usar una herramienta durante el resumen aislado; usando extracto de la Transcripción.`,
    isolatedEmpty: (agentName) =>
      `${agentName} devolvió un resumen aislado vacío; usando extracto de la Transcripción.`,
    isolatedFailed: (agentName) =>
      `${agentName} falló durante el resumen aislado; usando extracto de la Transcripción.`,
    modelNotOffered: (requestedModel, targetName) =>
      `${targetName} no ofrece el Modelo "${requestedModel}".`,
    modelPrefilledDefault: (targetName, desiredModel, configuredDefault) =>
      `${targetName} no ofrece "${desiredModel}"; se preseleccionó el predeterminado "${configuredDefault}" en lugar de sustituirlo en silencio.`,
    modelNoValidDefault: (targetName, desiredModel) =>
      `${targetName} no ofrece "${desiredModel}" y no tiene un Modelo predeterminado válido; selecciona un Modelo abajo.`,
    effortUnavailable: (targetName) => `Esfuerzo no disponible en ${targetName}.`,
    askModeUnavailable: (targetName) =>
      `El modo Preguntar no está disponible en ${targetName}; se usará Auto.`,
    diskStateEdits:
      'El destino realizó ediciones de archivos antes de que fallara la transferencia; los cambios en disco siguen visibles.',
    acknowledged: 'Transferencia confirmada.',
    requestedPermission: (targetName) =>
      `${targetName} solicitó permiso de herramienta en lugar de confirmar la transferencia.`,
    ranUnexpectedSteps: (targetName) =>
      `${targetName} ejecutó pasos de herramienta inesperados en lugar de confirmar la transferencia.`,
    startupCancelled: 'El inicio de la transferencia fue cancelado o detenido.',
    didNotAcknowledge: (targetName) => `${targetName} no confirmó limpiamente la transferencia.`,
  },
};

/** Localized copy for main-owned Session and Handoff messages. */
export const sessionCopy = (locale: Locale): SessionCopy => (locale === 'es' ? ES : EN);
