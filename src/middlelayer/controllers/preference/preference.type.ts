export type WorkflowPreferenceModule = 'USER' | 'ORG' | 'WORKFLOW';

export type WorkflowPreferenceOption = {
  levelsHash: string;
  name: string;
  alias: string;
  selected: boolean;
};

export type WorkflowPreferenceNode = {
  nodeName: string;
  nodePath: string;
  nodeType: string;
  modules: Partial<
    Record<
      WorkflowPreferenceModule,
      {
        workflows: WorkflowPreferenceOption[];
      }
    >
  >;
};

export type FetchUserWorkflowPreferencesResponse = {
  message: string;
  code: number;
  data: WorkflowPreferenceNode[];
};

export type UpdateUserWorkflowPreferencesRequest = Array<{
  type: 'ADDED' | 'REMOVED';
  module: WorkflowPreferenceModule;
  nodePath: string;
  levelsHash: string;
  remarks?: string;
}>;

export type UpdateUserWorkflowPreferencesResponse = {
  message: string;
  code: number;
  data: Array<{
    type: 'ADDED' | 'REMOVED';
    module: WorkflowPreferenceModule;
    nodePath: string;
    levelsHash: string;
    workflowId?: string | null;
    preferenceId?: string | null;
  }>;
};

export type WorkflowPreferenceApiErrorResponse = {
  message?: string;
  error?: string;
  code?: number;
};
