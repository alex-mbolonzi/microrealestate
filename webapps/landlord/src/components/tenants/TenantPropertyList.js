import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import PropertyIcon from '../properties/PropertyIcon';

function Address({ address }) {
  if (!address?.street1) {
    return null;
  }

  return (
    <p className="text-xs text-muted-foreground">
      {address.street1}
      <br />
      {address.street2 ? (
        <>
          {address.street2}
          <br />
        </>
      ) : null}
      {address.city} {address.zipCode}
      <br />
      {address.state && address.country
        ? `${address.state} ${address.country}`
        : address.country}
    </p>
  );
}

export default function TenantPropertyList({ tenant, className }) {
  // Add an early exit if tenant or its properties array is not valid
  if (!tenant || !tenant.properties || !Array.isArray(tenant.properties)) {
    return null; // Or return a message like <div className={className}>No properties to display.</div>
  }

  return (
    <div className={cn('flex flex-wrap gap-4 p-4 border rounded', className)}>
      {tenant.properties.map(({ property }, index) => { // Added 'index' for fallback key
        // Crucial Check: Ensure 'property' itself is not null or undefined
        if (!property) {
          console.warn('Skipping malformed property item in tenant.properties array:', tenant.properties[index]);
          return null; // Skip rendering this specific item if 'property' is missing
        }

        return (
          <Popover key={property._id || index}> {/* Use index as fallback key */}
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon">
                <PropertyIcon
                  key={property._id || `icon-${index}`} // Use index as fallback key
                  type={property.type} // Now property.type is safe to access
                  className="size-8"
                />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-4">
              <div>
                <p className="text-sm font-medium leading-none">
                  {property.name}
                </p>
                {!!property.description && (
                  <p className="text-xs text-muted-foreground">
                    {property.description}
                  </p>
                )}

                <Address address={property.address} />
              </div>
            </PopoverContent>
          </Popover>
        );
      })}
    </div>
  );
}
