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
  company: CompanyInfo;
}

/**
 * Helper to group companies by their groups for response formatting.
 * If a company has no group association, it's placed in an 'Independent' category.
 */
export const formatUserGroups = (userMappings: UserMappingInfo[]) => {
  const groupsMap = new Map<string, Record<string, any>>();

  userMappings.forEach((um) => {
    const company = {
      legalName: um.company.legalName,
      brandName: um.company.brandName,
      companyCode: um.company.companyCode,
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
