import ExcelJS from 'exceljs';

type TemplateRole = {
  roleName: string;
  category: string;
  subCategory: string;
};

type TemplateNode = {
  nodeName: string;
  nodePath: string;
};

type TemplateManager = {
  email: string;
};

type TemplateAccess = {
  accessType: 'PRIMARY' | 'SECONDARY' | string | null;
  roleName: string | null;
  roleCategory: string | null;
  roleSubCategory: string | null;
  nodeName: string | null;
  nodePath: string | null;
  accessCategory: 'ALL_CHILD' | 'IMMEDIATE_CHILD' | 'NODE' | string | null;
};

export type UserBulkUploadTemplateRow = {
  name: string;
  email: string;
  phone: string;
  designation?: string | null;
  employeeId?: string | null;
  reportingManagerEmail?: string | null;
  inactive?: boolean;
  archive?: boolean;
  accesses: TemplateAccess[];
};

type BuildUserBulkUploadTemplateOptions = {
  roles: TemplateRole[];
  nodes: TemplateNode[];
  managers: TemplateManager[];
  maxAccess?: number;
  templateType?: 'INITIATE' | 'MODIFY';
  rows?: UserBulkUploadTemplateRow[];
};

const DEFAULT_MAX_ACCESS = 10;
const MAX_ACCESS_BLOCKS = 50;
const MAX_TEMPLATE_ROWS = 1000;

const uniqueSorted = (values: Array<string | null | undefined>) =>
  Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));

const applyListValidation = (
  worksheet: ExcelJS.Worksheet,
  columnNumber: number,
  formula: string,
) => {
  for (let rowNumber = 2; rowNumber <= MAX_TEMPLATE_ROWS + 1; rowNumber++) {
    worksheet.getCell(rowNumber, columnNumber).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid value',
      error: 'Please select a value from the dropdown list.',
    };
  }
};

const applyCustomValidation = (
  worksheet: ExcelJS.Worksheet,
  columnNumber: number,
  formulaForRow: (rowNumber: number) => string,
  error: string,
) => {
  for (let rowNumber = 2; rowNumber <= MAX_TEMPLATE_ROWS + 1; rowNumber++) {
    worksheet.getCell(rowNumber, columnNumber).dataValidation = {
      type: 'custom',
      allowBlank: true,
      formulae: [formulaForRow(rowNumber)],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid value',
      error,
    };
  }
};

const writeList = (
  worksheet: ExcelJS.Worksheet,
  columnNumber: number,
  values: string[],
) => {
  values.forEach((value, index) => {
    worksheet.getCell(index + 2, columnNumber).value = value;
  });
};

const applyFormula = (
  worksheet: ExcelJS.Worksheet,
  columnNumber: number,
  formulaForRow: (rowNumber: number) => string,
) => {
  for (let rowNumber = 2; rowNumber <= MAX_TEMPLATE_ROWS + 1; rowNumber++) {
    worksheet.getCell(rowNumber, columnNumber).value = {
      formula: formulaForRow(rowNumber),
      result: '',
    };
  }
};

const unlockDataCells = (worksheet: ExcelJS.Worksheet, columnNumber: number) => {
  for (let rowNumber = 2; rowNumber <= MAX_TEMPLATE_ROWS + 1; rowNumber++) {
    worksheet.getCell(rowNumber, columnNumber).protection = {
      locked: false,
    };
  }
};

const rangeFormula = (columnLetter: string, values: string[]) =>
  values.length > 0
    ? `'DropdownData'!$${columnLetter}$2:$${columnLetter}$${values.length + 1}`
    : undefined;

const setCellValue = (
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  columnKey: string,
  value: ExcelJS.CellValue,
) => {
  const column = worksheet.getColumnKey(columnKey);
  if (!column?.number) return;
  worksheet.getCell(rowNumber, column.number).value = value;
};

export const buildUserBulkUploadTemplate = async ({
  roles,
  nodes,
  managers,
  maxAccess = DEFAULT_MAX_ACCESS,
  templateType = 'INITIATE',
  rows = [],
}: BuildUserBulkUploadTemplateOptions) => {
  const accessCount = Math.min(
    Math.max(Number(maxAccess) || DEFAULT_MAX_ACCESS, 1),
    MAX_ACCESS_BLOCKS,
  );
  const isModifyTemplate = templateType === 'MODIFY';
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RJFintech';
  workbook.created = new Date();

  const usersSheet = workbook.addWorksheet('Users', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const dropdownSheet = workbook.addWorksheet('DropdownData');
  dropdownSheet.state = 'veryHidden';

  const baseColumns = [
    { header: 'Full Name *', key: 'name', width: 24 },
    { header: 'Email *', key: 'email', width: 30 },
    { header: 'Phone *', key: 'phone', width: 18 },
    { header: 'Designation', key: 'designation', width: 24 },
    { header: 'Employee ID', key: 'employeeId', width: 18 },
    {
      header: 'Reporting Manager Email *',
      key: 'reportingManagerEmail',
      width: 32,
    },
    ...(isModifyTemplate
      ? [
        { header: 'Inactive', key: 'inactive', width: 14 },
        { header: 'Archive', key: 'archive', width: 14 },
      ]
      : []),
  ];
  const accessColumns = Array.from({ length: accessCount }, (_, index) => {
      const accessNumber = index + 1;
    const requiredMarker = accessNumber === 1 ? ' *' : '';
    return [
      {
        header: `Access ${accessNumber} Type${requiredMarker}`,
        key: `access${accessNumber}Type`,
        width: 16,
      },
      {
        header: `Access ${accessNumber} Role Name${requiredMarker}`,
        key: `access${accessNumber}RoleName`,
        width: 28,
      },
      {
        header: `Access ${accessNumber} Role Category${requiredMarker}`,
        key: `access${accessNumber}RoleCategory`,
        width: 22,
      },
      {
        header: `Access ${accessNumber} Role Sub Category${requiredMarker}`,
        key: `access${accessNumber}RoleSubCategory`,
        width: 24,
      },
      {
        header: `Access ${accessNumber} Node Name${requiredMarker}`,
        key: `access${accessNumber}NodeName`,
        width: 28,
      },
      {
        header: `Access ${accessNumber} Node Path${requiredMarker}`,
        key: `access${accessNumber}NodePath`,
        width: 34,
      },
      {
        header: `Access ${accessNumber} Category${requiredMarker}`,
        key: `access${accessNumber}Category`,
        width: 20,
      },
    ];
  }).flat();

  usersSheet.columns = [...baseColumns, ...accessColumns];
  usersSheet.getRow(1).font = { bold: true };
  usersSheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9EAF7' },
  };
  usersSheet.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  usersSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: usersSheet.columnCount },
  };

  const addHeaderNote = (columnNumber: number, note: string) => {
    usersSheet.getCell(1, columnNumber).note = note;
  };
  addHeaderNote(1, 'Required. Name must be between 2 and 20 characters.');
  addHeaderNote(2, 'Required. Enter a valid email address.');
  addHeaderNote(3, 'Required. Phone number must contain 10 to 15 digits.');
  addHeaderNote(6, 'Required. Select reporting manager email from dropdown.');
  if (isModifyTemplate) {
    addHeaderNote(2, 'Locked in modify template. Email is used to identify the user.');
    addHeaderNote(5, 'Locked in modify template.');
    addHeaderNote(6, 'Locked in modify template.');
    addHeaderNote(7, 'Optional. Select TRUE to mark user inactive.');
    addHeaderNote(8, 'Optional. Select TRUE to archive user.');
  }

  const baseColumnCount = baseColumns.length;
  const accessStartColumn = baseColumnCount + 1;

  const editableBaseColumns = isModifyTemplate
    ? [1, 3, 4, 7, 8]
    : Array.from({ length: baseColumnCount }, (_, index) => index + 1);
  editableBaseColumns.forEach((columnNumber) =>
    unlockDataCells(usersSheet, columnNumber),
  );

  for (let accessNumber = 1; accessNumber <= accessCount; accessNumber++) {
    const startColumn = accessStartColumn + (accessNumber - 1) * 7;
    [startColumn, startColumn + 1, startColumn + 4, startColumn + 6].forEach(
      (columnNumber) => unlockDataCells(usersSheet, columnNumber),
    );

    if (accessNumber === 1) {
      addHeaderNote(startColumn, 'Required. Access 1 Type is PRIMARY only.');
      addHeaderNote(startColumn + 1, 'Required. Select role name from dropdown.');
      addHeaderNote(startColumn + 2, 'Auto-filled from role name.');
      addHeaderNote(startColumn + 3, 'Auto-filled from role name.');
      addHeaderNote(startColumn + 4, 'Required. Select node name from dropdown.');
      addHeaderNote(startColumn + 5, 'Auto-filled from node name.');
      addHeaderNote(
        startColumn + 6,
        'Defaults to NODE when node name is selected. User can change to IMMEDIATE_CHILD or ALL_CHILD.',
      );
    } else {
      addHeaderNote(
        startColumn,
        `Optional. Access ${accessNumber} Type is SECONDARY only.`,
      );
      addHeaderNote(
        startColumn + 1,
        `Required only when Access ${accessNumber} is used.`,
      );
      addHeaderNote(startColumn + 2, 'Auto-filled from role name.');
      addHeaderNote(startColumn + 3, 'Auto-filled from role name.');
      addHeaderNote(
        startColumn + 4,
        `Required only when Access ${accessNumber} is used.`,
      );
      addHeaderNote(startColumn + 5, 'Auto-filled from node name.');
      addHeaderNote(
        startColumn + 6,
        `Defaults to NODE when node name is selected. User can change to IMMEDIATE_CHILD or ALL_CHILD.`,
      );
    }
  }

  const primaryAccessTypes = ['PRIMARY'];
  const secondaryAccessTypes = ['SECONDARY'];
  const accessCategories = ['NODE', 'IMMEDIATE_CHILD', 'ALL_CHILD'];
  const booleanOptions = ['FALSE', 'TRUE'];
  const roleNames = uniqueSorted(roles.map((role) => role.roleName));
  const nodeNames = uniqueSorted(nodes.map((node) => node.nodeName));
  const managerEmails = uniqueSorted(managers.map((manager) => manager.email));

  dropdownSheet.columns = [
    { header: 'accessType', key: 'accessType', width: 20 },
    { header: 'accessCategory', key: 'accessCategory', width: 22 },
    { header: 'roleName', key: 'roleName', width: 32 },
    { header: 'roleCategory', key: 'roleCategory', width: 24 },
    { header: 'roleSubCategory', key: 'roleSubCategory', width: 26 },
    { header: 'nodeName', key: 'nodeName', width: 32 },
    { header: 'nodePath', key: 'nodePath', width: 40 },
    { header: 'reportingManagerEmail', key: 'reportingManagerEmail', width: 36 },
    { header: 'primaryAccessType', key: 'primaryAccessType', width: 20 },
    { header: 'secondaryAccessType', key: 'secondaryAccessType', width: 22 },
    { header: 'booleanOption', key: 'booleanOption', width: 18 },
  ];
  dropdownSheet.getRow(1).font = { bold: true };
  writeList(dropdownSheet, 2, accessCategories);
  writeList(dropdownSheet, 9, primaryAccessTypes);
  writeList(dropdownSheet, 10, secondaryAccessTypes);
  writeList(dropdownSheet, 11, booleanOptions);
  roles.forEach((role, index) => {
    const rowNumber = index + 2;
    dropdownSheet.getCell(rowNumber, 3).value = role.roleName;
    dropdownSheet.getCell(rowNumber, 4).value = role.category;
    dropdownSheet.getCell(rowNumber, 5).value = role.subCategory;
  });
  nodes.forEach((node, index) => {
    const rowNumber = index + 2;
    dropdownSheet.getCell(rowNumber, 6).value = node.nodeName;
    dropdownSheet.getCell(rowNumber, 7).value = node.nodePath;
  });
  writeList(dropdownSheet, 8, managerEmails);

  const formulas = {
    accessCategory: rangeFormula('B', accessCategories),
    roleName: rangeFormula('C', roleNames),
    nodeName: rangeFormula('F', nodeNames),
    reportingManagerEmail: rangeFormula('H', managerEmails),
    primaryAccessType: rangeFormula('I', primaryAccessTypes),
    secondaryAccessType: rangeFormula('J', secondaryAccessTypes),
    booleanOption: rangeFormula('K', booleanOptions),
  };

  if (formulas.reportingManagerEmail) {
    applyListValidation(usersSheet, 6, formulas.reportingManagerEmail);
  }
  if (isModifyTemplate && formulas.booleanOption) {
    applyListValidation(usersSheet, 7, formulas.booleanOption);
    applyListValidation(usersSheet, 8, formulas.booleanOption);
  }
  usersSheet.addConditionalFormatting({
    ref: `F2:F${MAX_TEMPLATE_ROWS + 1}`,
    rules: [
      {
        type: 'expression',
        priority: 1,
        formulae: ['AND(COUNTA($A2:$C2)>0,$F2="")'],
        style: {
          fill: {
            type: 'pattern',
            pattern: 'solid',
            bgColor: { argb: 'FFFFC7CE' },
          },
          font: {
            color: { argb: 'FF9C0006' },
          },
        },
      },
    ],
  });

  applyCustomValidation(
    usersSheet,
    1,
    (rowNumber) => `OR(A${rowNumber}="",AND(LEN(A${rowNumber})>=2,LEN(A${rowNumber})<=20))`,
    'Name must be between 2 and 20 characters.',
  );
  applyCustomValidation(
    usersSheet,
    2,
    (rowNumber) =>
      `OR(B${rowNumber}="",AND(ISNUMBER(SEARCH("@",B${rowNumber})),ISNUMBER(SEARCH(".",B${rowNumber})),LEN(B${rowNumber})<=254))`,
    'Please enter a valid email address.',
  );
  applyCustomValidation(
    usersSheet,
    3,
    (rowNumber) =>
      `OR(C${rowNumber}="",AND(ISNUMBER(--C${rowNumber}),LEN(C${rowNumber})>=10,LEN(C${rowNumber})<=15))`,
    'Phone number must contain 10 to 15 digits.',
  );
  applyCustomValidation(
    usersSheet,
    4,
    (rowNumber) =>
      `OR(D${rowNumber}="",AND(LEN(D${rowNumber})>=2,LEN(D${rowNumber})<=100))`,
    'Designation must be between 2 and 100 characters when provided.',
  );
  applyCustomValidation(
    usersSheet,
    5,
    (rowNumber) =>
      `OR(E${rowNumber}="",AND(LEN(E${rowNumber})>=2,LEN(E${rowNumber})<=50))`,
    'Employee ID must be between 2 and 50 characters when provided.',
  );

  const accessTypeColumns = Array.from(
    { length: accessCount },
    (_, index) => usersSheet.getColumn(accessStartColumn + index * 7).letter,
  );
  const duplicatePrimaryFormula = (rowNumber: number) =>
    `SUM(${accessTypeColumns
      .map((letter) => `COUNTIF($${letter}${rowNumber},"PRIMARY")`)
      .join(',')})>1`;

  accessTypeColumns.forEach((letter) => {
    usersSheet.addConditionalFormatting({
      ref: `${letter}2:${letter}${MAX_TEMPLATE_ROWS + 1}`,
      rules: [
        {
          type: 'expression',
          priority: 1,
          formulae: [duplicatePrimaryFormula(2)],
          style: {
            fill: {
              type: 'pattern',
              pattern: 'solid',
              bgColor: { argb: 'FFFFC7CE' },
            },
            font: {
              color: { argb: 'FF9C0006' },
            },
          },
        },
      ],
    });
  });

  const duplicateAccessFormula = (
    roleColumn: string,
    nodePathColumn: string,
    rowNumber: number,
  ) => {
    const roleRanges = Array.from({ length: accessCount }, (_, index) => {
      const startColumn = 8 + index * 7;
      const roleLetter = usersSheet.getColumn(startColumn).letter;
      const nodeLetter = usersSheet.getColumn(startColumn + 4).letter;
      return `(($${roleLetter}${rowNumber}=$${roleColumn}${rowNumber})*($${nodeLetter}${rowNumber}=$${nodePathColumn}${rowNumber}))`;
    }).join('+');

    return `AND($${roleColumn}${rowNumber}<>"",$${nodePathColumn}${rowNumber}<>"",SUM(${roleRanges})>1)`;
  };

  for (let accessNumber = 1; accessNumber <= accessCount; accessNumber++) {
    const startColumn = accessStartColumn + (accessNumber - 1) * 7;
    const accessTypeFormula =
      accessNumber === 1
        ? formulas.primaryAccessType
        : formulas.secondaryAccessType;
    if (accessTypeFormula) {
      applyListValidation(usersSheet, startColumn, accessTypeFormula);
    }
    if (formulas.roleName) {
      applyListValidation(usersSheet, startColumn + 1, formulas.roleName);
    }
    if (formulas.nodeName) {
      applyListValidation(usersSheet, startColumn + 4, formulas.nodeName);
    }
    if (formulas.accessCategory) {
      applyListValidation(usersSheet, startColumn + 6, formulas.accessCategory);
    }

    applyFormula(
      usersSheet,
      startColumn + 2,
      (rowNumber) =>
        `IF(${usersSheet.getColumn(startColumn + 1).letter}${rowNumber}="","",IFERROR(VLOOKUP(${usersSheet.getColumn(startColumn + 1).letter}${rowNumber},DropdownData!$C:$E,2,FALSE),""))`,
    );
    applyFormula(
      usersSheet,
      startColumn + 3,
      (rowNumber) =>
        `IF(${usersSheet.getColumn(startColumn + 1).letter}${rowNumber}="","",IFERROR(VLOOKUP(${usersSheet.getColumn(startColumn + 1).letter}${rowNumber},DropdownData!$C:$E,3,FALSE),""))`,
    );
    applyFormula(
      usersSheet,
      startColumn + 5,
      (rowNumber) =>
        `IF(${usersSheet.getColumn(startColumn + 4).letter}${rowNumber}="","",IFERROR(VLOOKUP(${usersSheet.getColumn(startColumn + 4).letter}${rowNumber},DropdownData!$F:$G,2,FALSE),""))`,
    );
    applyFormula(
      usersSheet,
      startColumn + 6,
      (rowNumber) =>
        `IF(${usersSheet.getColumn(startColumn + 4).letter}${rowNumber}="","","NODE")`,
    );

    const roleColumn = usersSheet.getColumn(startColumn + 1).letter;
    const nodePathColumn = usersSheet.getColumn(startColumn + 5).letter;
    [startColumn + 1, startColumn + 5].forEach((columnNumber) => {
      const columnLetter = usersSheet.getColumn(columnNumber).letter;
      usersSheet.addConditionalFormatting({
        ref: `${columnLetter}2:${columnLetter}${MAX_TEMPLATE_ROWS + 1}`,
        rules: [
          {
            type: 'expression',
            priority: 2,
            formulae: [duplicateAccessFormula(roleColumn, nodePathColumn, 2)],
            style: {
              fill: {
                type: 'pattern',
                pattern: 'solid',
                bgColor: { argb: 'FFFFC7CE' },
              },
              font: {
                color: { argb: 'FF9C0006' },
              },
            },
          },
        ],
      });
    });
  }

  const templateRows =
    rows.length > 0
      ? rows
      : isModifyTemplate
        ? []
        : [
          {
            name: 'Rahul Sharma',
            email: 'rahul@test.com',
            phone: '9876543210',
            designation: 'Accounts Executive',
            employeeId: 'EMP001',
            reportingManagerEmail: managerEmails[0] ?? '',
            accesses: [
              {
                accessType: 'PRIMARY',
                roleName: roleNames[0] ?? '',
                roleCategory: roles[0]?.category ?? '',
                roleSubCategory: roles[0]?.subCategory ?? '',
                nodeName: nodeNames[0] ?? '',
                nodePath: nodes[0]?.nodePath ?? '',
                accessCategory: 'NODE',
              },
            ],
          },
        ];

  templateRows.slice(0, MAX_TEMPLATE_ROWS).forEach((row, index) => {
    const rowNumber = index + 2;
    setCellValue(usersSheet, rowNumber, 'name', row.name || '');
    setCellValue(usersSheet, rowNumber, 'email', row.email || '');
    setCellValue(usersSheet, rowNumber, 'phone', row.phone || '');
    setCellValue(usersSheet, rowNumber, 'designation', row.designation || '');
    setCellValue(usersSheet, rowNumber, 'employeeId', row.employeeId || '');
    setCellValue(
      usersSheet,
      rowNumber,
      'reportingManagerEmail',
      row.reportingManagerEmail || '',
    );
    if (isModifyTemplate) {
      setCellValue(usersSheet, rowNumber, 'inactive', row.inactive ? 'TRUE' : 'FALSE');
      setCellValue(usersSheet, rowNumber, 'archive', row.archive ? 'TRUE' : 'FALSE');
    }

    row.accesses.slice(0, accessCount).forEach((access, accessIndex) => {
      const accessNumber = accessIndex + 1;
      setCellValue(
        usersSheet,
        rowNumber,
        `access${accessNumber}Type`,
        access.accessType || '',
      );
      setCellValue(
        usersSheet,
        rowNumber,
        `access${accessNumber}RoleName`,
        access.roleName || '',
      );
      setCellValue(
        usersSheet,
        rowNumber,
        `access${accessNumber}RoleCategory`,
        access.roleCategory || '',
      );
      setCellValue(
        usersSheet,
        rowNumber,
        `access${accessNumber}RoleSubCategory`,
        access.roleSubCategory || '',
      );
      setCellValue(
        usersSheet,
        rowNumber,
        `access${accessNumber}NodeName`,
        access.nodeName || '',
      );
      setCellValue(
        usersSheet,
        rowNumber,
        `access${accessNumber}NodePath`,
        access.nodePath || '',
      );
      setCellValue(
        usersSheet,
        rowNumber,
        `access${accessNumber}Category`,
        access.accessCategory || '',
      );
    });
  });

  await usersSheet.protect('RJFintechBulkUpload', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: true,
  });
  await dropdownSheet.protect('RJFintechBulkUpload', {
    selectLockedCells: false,
    selectUnlockedCells: false,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    deleteColumns: false,
    deleteRows: false,
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
};
