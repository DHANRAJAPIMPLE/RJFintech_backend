interface GroupCompanyInfo {
  name: string;
  groupCode: string;
}

interface CompanyMappingInfo {
  group: GroupCompanyInfo | null;
}

interface CompanyInfo {
  legalName: string;
  brandName: string;
  companyCode: string;
  companyMappings: CompanyMappingInfo[];
}

interface UserMappingInfo {
  companyId: string;
  company: CompanyInfo;
}

/**
 * User Group Utility:
 * Transforms raw user-company mapping data into a grouped structure for the frontend.
 *
 * Why we use it:
 * - To organize companies under their respective parent 'Groups' (e.g., Reliance Group).
 * - To handle companies that don't belong to any group by categorizing them as 'Independent'.
 * - It provides a clean, hierarchical view of user access for the UI.
 */
export const formatUserGroups = (
  userMappings: UserMappingInfo[],
  reporteeCountByCompanyId: Record<string, number> = {},
) => {
  const groupsMap = new Map<string, Record<string, any>>();

  userMappings.forEach((um) => {
    const company = {
      legalName: um.company.legalName,
      brandName: um.company.brandName,
      companyCode: um.company.companyCode,
      reporteeCount: reporteeCountByCompanyId[um.companyId] ?? 0,
    };

    const mappings = um.company.companyMappings;
    if (mappings && mappings.length > 0) {
      mappings.forEach((cm) => {
        if (cm.group) {
          const groupCode = cm.group.groupCode;
          if (!groupsMap.has(groupCode)) {
            groupsMap.set(groupCode, {
              groupName: cm.group.name,
              groupCode: cm.group.groupCode,
              companies: [],
            });
          }
          const groupObj = groupsMap.get(groupCode);
          const companies = groupObj?.companies as Record<string, any>[];
          if (!companies.some((c) => c.companyCode === company.companyCode)) {
            companies.push(company);
          }
        }
      });
    } else {
      const groupCode = 'IND';
      if (!groupsMap.has(groupCode)) {
        groupsMap.set(groupCode, {
          groupName: 'Independent',
          groupCode: 'IND',
          companies: [],
        });
      }
      const groupObj = groupsMap.get(groupCode);
      const companies = groupObj?.companies as Record<string, any>[];
      if (!companies.some((c) => c.companyCode === company.companyCode)) {
        companies.push(company);
      }
    }
  });

  return Array.from(groupsMap.values());
};
