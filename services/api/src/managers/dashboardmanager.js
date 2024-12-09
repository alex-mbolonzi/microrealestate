import { Collections } from '@microrealestate/common';
import moment from 'moment';

export async function all(req, res) {
  const now = moment();
  const beginOfTheMonth = moment(now).startOf('month');
  const endOfTheMonth = moment(now).endOf('month');
  const beginOfTheYear = moment(now).startOf('year');
  const endOfTheYear = moment(now).endOf('year');
  const realmId = req.headers.organizationid;

  // Parallel database queries for better performance
  const [
    tenants,
    propertyCount,
    rentPayments
  ] = await Promise.all([
    // Only fetch necessary tenant fields
    Collections.Tenant.find(
      { realmId },
      { properties: 1, terminationDate: 1, endDate: 1 }
    ).lean(),
    
    Collections.Property.countDocuments({ realmId }),
    
    Collections.Rent.aggregate([
      { $match: { 
        realmId,
        date: { 
          $gte: beginOfTheYear.toDate(),
          $lte: endOfTheYear.toDate() 
        }
      }},
      { $group: {
        _id: null,
        totalAmount: { $sum: "$totalAmount" },
        totalPayments: { $sum: "$payment" }
      }}
    ])
  ]);

  // Calculate active tenants
  const activeTenants = tenants.filter(tenant => {
    const terminationMoment = tenant.terminationDate
      ? moment(tenant.terminationDate)
      : moment(tenant.endDate);
    return terminationMoment.isSameOrAfter(now, 'day');
  });

  // Calculate occupancy rate
  let occupancyRate = 0;
  if (propertyCount > 0) {
    const rentedProperties = new Set(
      activeTenants.flatMap(tenant => 
        (tenant.properties || []).map(p => p.propertyId)
      )
    );
    occupancyRate = rentedProperties.size / propertyCount;
  }

  // Get revenue data
  const yearRevenue = rentPayments[0]?.totalAmount || 0;
  const yearPaid = rentPayments[0]?.totalPayments || 0;

  res.json({
    propertyCount,
    tenantCount: activeTenants.length,
    occupancyRate,
    yearRevenue,
    yearPaid,
    beginOfYear: beginOfTheYear.format(),
    endOfYear: endOfTheYear.format(),
    beginOfMonth: beginOfTheMonth.format(),
    endOfMonth: endOfTheMonth.format()
  });
}
