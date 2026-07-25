function render(view, title, subtitle = "") {
  return (req, res) => res.render(view, { title, subtitle });
}

const plansPage = render(
  "wallet/index",
  "Plans & credits",
  "Choose a plan, manage credits and review payment activity",
);

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
  plans: plansPage,
  wallet: plansPage,
  profile: render(
    "profile/index",
    "My profile",
    "Provider details managed from the CRM",
  ),
};

module.exports = frontendController;
