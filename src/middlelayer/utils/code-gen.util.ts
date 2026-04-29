import { config } from '../config';
import { internalPost } from './internal-fetch.util';

export class CodeGenUtil {
  private static normalizeCodeNamePart(value: string): string {
    const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return normalized.slice(0, 8).padEnd(8, 'X');
  }

  private static formatCodeDatePart(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    return `${day}${month}${year}`;
  }

  static async generateUniqueCompanyCode(companyName: string): Promise<string> {
    const namePart = this.normalizeCodeNamePart(companyName);
    const datePart = this.formatCodeDatePart(new Date());
    const baseCode = `${namePart}${datePart}`;
    let code = baseCode;
    let counter = 1;
    let isUnique = false;

    while (!isUnique) {
      const { data } = await internalPost<any>(
        `${config.backendUrl}/internal/onboarding/company/check-code`,
        { code },
      );
      if (!data.exists) {
        isUnique = true;
      } else {
        code = `${baseCode}${counter}`;
        counter++;
      }
    }
    return code;
  }

  static async generateUniqueGroupCode(groupName: string): Promise<string> {
    const namePart = this.normalizeCodeNamePart(groupName);
    const datePart = this.formatCodeDatePart(new Date());
    const baseCode = `${namePart}${datePart}`;
    let code = baseCode;
    let counter = 1;
    let isUnique = false;

    while (!isUnique) {
      const { data } = await internalPost<any>(
        `${config.backendUrl}/internal/onboarding/group/check-code`,
        { code },
      );
      if (!data.exists) {
        isUnique = true;
      } else {
        code = `${baseCode}${counter}`;
        counter++;
      }
    }
    return code;
  }
}
