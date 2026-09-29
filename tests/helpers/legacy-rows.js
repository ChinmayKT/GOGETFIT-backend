/** Fixture rows shaped like m_user, used so the pipeline can be tested without
 *  touching MariaDB. Authentication columns are absent by construction. */
export const legacyRow = (overrides = {}) => ({
  user_id: 1001,
  first_name: 'John',
  last_name: 'Doe',
  gender: 'male',
  dob: '2001-09-22',
  email_id: 'john@example.com',
  phone_number: '9999999999',
  city_name: 'Bengaluru',
  state_name: 'Karnataka',
  country_name: 'India',
  zip_code: '560001',
  address: '1 Example Road',
  height: 180,
  weight: 75,
  age: 99,
  points: 10,
  user_type: 'client',
  coach_id: 7,
  create_date: '2019-04-01 10:00:00',
  ...overrides,
});
