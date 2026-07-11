function render(view, title, subtitle = "") {
  return (req, res) => res.render(view, { title, subtitle });
}

const frontendController = {
  login: render("auth/login", "Provider login"),
  dashboard: render(
    "dashboard/index",
    "Dashboard",
    "Category-matched leads and credit activity",
  ),
  leads: render(
    "lead/index",
    "Lead marketplace",
    "Leads approved by CRM and matched to your categories",
  ),
  lead: render("lead/show", "Lead details"),
  wallet: render(
    "wallet/index",
    "Credits",
    "Buy credits through Razorpay and review every credit entry",
  ),
  profile: render(
    "profile/index",
    "My profile",
    "Provider details managed from the CRM",
  ),
};

module.exports = frontendController;
