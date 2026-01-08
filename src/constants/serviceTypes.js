const SERVICE_TYPES = {
  CITY_RIDE: 'CITY_RIDE',
  DELIVERY_BIKE: 'DELIVERY_BIKE',
  TRUCK: 'TRUCK',
  INTERSTATE: 'INTERSTATE',
  KEKE: 'KEKE',
  LUXURY_RENTAL: 'LUXURY_RENTAL'
};

function isLuxury(serviceType) {
  return serviceType === SERVICE_TYPES.LUXURY_RENTAL;
}

module.exports = { SERVICE_TYPES, isLuxury };
