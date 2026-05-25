import { createRouter, createWebHashHistory } from 'vue-router';

const RosterView = () => import('./views/RosterView.vue');
const InstantiateView = () => import('./views/InstantiateView.vue');
const InspectView = () => import('./views/InspectView.vue');
const NewCompanyView = () => import('./views/NewCompanyView.vue');

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: RosterView },
    { path: '/instantiate', component: InstantiateView },
    { path: '/new-company', component: NewCompanyView },
    { path: '/lattice/:id', component: InspectView, props: true },
  ],
});
