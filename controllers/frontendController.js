function render(view, title, subtitle = '', extra = () => ({})) {
  return (req, res) => res.render(view, {
    title,
    subtitle,
    currentPath: req.path,
    currentStatus: String(req.query.status || ''),
    searchQuery: String(req.query.q || ''),
    ...extra(req)
  });
}

module.exports = {
  login: render('auth/login', 'Provider login', '', (req) => ({
    returnTo: req.query.returnTo || '/dashboard'
  })),
  dashboard: render(
    'dashboard/index',
    'Dashboard',
    'Category-matched leads and wallet activity'
  ),
  leads: render(
    'lead/index',
    'Lead marketplace',
    'Leads approved by CRM and matched to your categories'
  ),
  lead: render('lead/show', 'Lead details', '', (req) => ({
    recordId: req.params.leadDistributionId
  })),
  wallet: render(
    'wallet/index',
    'Wallet',
    'Add funds and review every wallet credit and deduction'
  ),
  profile: render(
    'profile/index',
    'My profile',
    'Provider details managed from the CRM'
  )
};
