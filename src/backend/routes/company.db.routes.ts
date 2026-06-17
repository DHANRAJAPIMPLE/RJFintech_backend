import { Router } from 'express';
import { CompanyDbController } from '../modules/company/company.db.modules';

const router = Router();

router.post('/my-companies', CompanyDbController.getMyCompanies);
router.post('/groups', CompanyDbController.getGroupCompanies);
router.post('/get-by-code', CompanyDbController.getCompanyByCode);
router.post('/details', CompanyDbController.getCompanyDetailsByCode);
router.post('/get-by-id', CompanyDbController.getCompanyById);
router.post('/create', CompanyDbController.createCompanyOnboarding);
router.post('/get', CompanyDbController.getCompanyOnboardingById);
router.post('/action', CompanyDbController.handleCompanyOnboardingStatus);
router.post('/history', CompanyDbController.fetchCompanyHistory);
router.post('/check-company', CompanyDbController.checkCompany);
router.post('/check-signatories', CompanyDbController.checkSignatories);

export default router;
