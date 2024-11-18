import { Cell, Legend, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { LuAlertTriangle, LuBanknote } from 'react-icons/lu';
import { useContext, useMemo } from 'react';
import { Button } from '../ui/button';
import { CelebrationIllustration } from '../../components/Illustrations';
import { cn } from '../../utils';
import { DashboardCard } from './DashboardCard';
import moment from 'moment';
import NumberFormat from '../NumberFormat';
import { observer } from 'mobx-react-lite';
import { StoreContext } from '../../store';
import useFormatNumber from '../../hooks/useFormatNumber';
import { useRouter } from 'next/router';
import useTranslation from 'next-translate/useTranslation';

function MonthFigures({ className }) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const store = useContext(StoreContext);
  const formatNumber = useFormatNumber();
  const yearMonth = moment().format('YYYY.MM');
  const data = useMemo(() => {
    const currentRevenues = store.dashboard.currentRevenues;
    return [
      {
        name: 'notPaid',
        value: currentRevenues.notPaid,
        yearMonth,
        status: 'notpaid'
      },
      {
        name: 'paid',
        value: currentRevenues.paid,
        yearMonth,
        status: 'paid'
      }
    ];
  }, [store.dashboard.currentRevenues, yearMonth]);

  const numberOfSlices = useMemo(() => {
    return data.filter(({ value }) => value > 0).length;
  }, [data]);

  return (
    <div className={cn('grid grid-cols-1 gap-4', className)}>
      <DashboardCard
        Icon={LuBanknote}
        title={t('Settlements')}
        description={t('Rents of {{monthYear}}', {
          monthYear: moment().format('MMMM YYYY')
        })}
        renderContent={() => (
          <ResponsiveContainer height={262}>
            <PieChart>
              <Legend
                verticalAlign="top"
                content={() => (
                  <div className="flex justify-center gap-4 text-sm">
                    <div className="flex items-center gap-2 text-warning">
                      <div className="size-2 bg-[hsl(var(--chart-1))]" />
                      <span>{t('Not paid')}</span>
                    </div>
                    <div className="flex items-center gap-2 text-success">
                      <div className="size-2 bg-[hsl(var(--chart-2))]" />
                      <span>{t('Paid')}</span>
                    </div>
                  </div>
                )}
              />
              <Pie
                data={data}
                startAngle={180}
                endAngle={0}
                cy="80%"
                paddingAngle={numberOfSlices === 1 ? 0 : 4}
                dataKey="value"
                innerRadius="50%"
                cursor="pointer"
                onClick={(data) => {
                  if (!data?.payload) {
                    return;
                  }
                  const {
                    payload: { yearMonth, status }
                  } = data;
                  store.rent.setFilters({ status: [status] });
                  router.push(
                    `/${store.organization.selected.name}/rents/${yearMonth}?status=${status}`
                  );
                }}
                label={(props) => {
                  const { x, y, name, value } = props;
                  const color =
                    name === 'paid'
                      ? 'hsl(var(--success))'
                      : 'hsl(var(--warning))';

                  return (
                    <text
                      x={x - 20}
                      y={y - 10}
                      fill={color}
                      className="text-xs"
                    >
                      {value !== undefined && value ? formatNumber(value) : ''}
                    </text>
                  );
                }}
                labelLine={false}
              >
                <Cell
                  fill="hsl(var(--chart-1))"
                  stroke="hsl(var(--chart-1-border))"
                />
                <Cell
                  fill="hsl(var(--chart-2))"
                  stroke="hsl(var(--chart-2-border))"
                />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        )}
      />

      <DashboardCard
        Icon={store.dashboard.data.topUnpaid?.length ? LuAlertTriangle : null}
        title={
          store.dashboard.data.topUnpaid?.length
            ? t('Top 5 of not paid rents')
            : ''
        }
        description={
          store.dashboard.data.topUnpaid?.length
            ? t('Tenants with the highest unpaid balance')
            : ''
        }
        renderContent={() =>
          store.dashboard.data.topUnpaid?.length ? (
            <div className="flex flex-col gap-2 min-h-48">
              {store.dashboard.data.topUnpaid.map(
                ({ tenant, balance, rent }) => (
                  <div
                    key={tenant._id}
                    className="flex items-center text-sm md:text-base"
                  >
                    <Button
                      variant="link"
                      onClick={() => {
                        store.rent.setSelected(rent);
                        store.rent.setFilters({ searchText: tenant.name });
                        router.push(
                          `/${store.organization.selected.name}/rents/${yearMonth}?search=${tenant.name}`
                        );
                      }}
                      className="justify-start flex-grow p-0 m-0"
                    >
                      {tenant.name}
                    </Button>
                    <NumberFormat
                      value={balance}
                      withColor
                      className="font-semibold"
                    />
                  </div>
                )
              )}
            </div>
          ) : (
            <CelebrationIllustration
              label={t('Well done! All rents are paid')}
            />
          )
        }
      />
    </div>
  );
}

export default observer(MonthFigures);
