export const TEMPLATE_MODULES = [
  'USER',
  'COMPANY',
  'ORG',
  'WORKFLOW',
] as const;

export const TEMPLATE_EVENTS = [
  'MODIFY',
  'ADDED',
  'REMOVED',
  'ELIGIBLE_APPROVERS_INITIATE',
  'REJECTED',
] as const;

export type TemplateModule = (typeof TEMPLATE_MODULES)[number];
export type TemplateEvent = (typeof TEMPLATE_EVENTS)[number];

export type TemplateState = {
  module: TemplateModule;
  event: TemplateEvent;
  isEnabled: boolean;
};

const TEMPLATE_MODULE_SET = new Set<string>(TEMPLATE_MODULES);
const TEMPLATE_EVENT_SET = new Set<string>(TEMPLATE_EVENTS);

export const normalizeTemplateModule = (value: unknown): TemplateModule | null => {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toUpperCase();
  return TEMPLATE_MODULE_SET.has(normalized)
    ? (normalized as TemplateModule)
    : null;
};

export const normalizeTemplateEvent = (value: unknown): TemplateEvent | null => {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return TEMPLATE_EVENT_SET.has(normalized)
    ? (normalized as TemplateEvent)
    : null;
};

export const buildTemplateMatrix = (
  templates: Array<{
    module: string;
    event: string;
    isEnabled: boolean;
  }>,
) => {
  const templateMap = new Map(
    templates.map((template) => [
      `${template.module}:${template.event}`,
      template.isEnabled,
    ]),
  );

  return TEMPLATE_MODULES.map((module) => ({
    module,
    events: TEMPLATE_EVENTS.map((event) => ({
      event,
      isEnabled: templateMap.get(`${module}:${event}`) ?? false,
    })),
  }));
};
