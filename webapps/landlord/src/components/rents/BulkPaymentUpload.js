import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { LuAlertTriangle, LuDownload, LuUpload } from 'react-icons/lu';
import Papa from 'papaparse';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import { useRef, useState } from 'react';

export default function BulkPaymentUpload({ isOpen, onClose, onSuccess }) {
  const { t } = useTranslation('common');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const downloadTemplate = () => {
    const headers = [
      'tenant_reference',
      'payment_date',
      'amount',
      'payment_type',
      'reference',
      'description',
      'promo_amount',
      'promo_note',
      'extra_charge',
      'extra_charge_note'
    ];
    const csv = Papa.unparse([headers]);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bulk_payments_template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const handleFileChange = (event) => {
    const selectedFile = event.target.files[0];
    if (selectedFile && selectedFile.type !== 'text/csv') {
      setError(t('Please select a valid CSV file'));
      return;
    }
    setFile(selectedFile);
    setError(null);
  };

  const handleUpload = async () => {
    if (!file) {
      setError(t('Please select a file first'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const parseFile = () => {
        return new Promise((resolve, reject) => {
          Papa.parse(file, {
            header: true,
            complete: (results) => resolve(results.data),
            error: (error) => reject(error)
          });
        });
      };

      const payments = await parseFile();
      
      const response = await fetch('/api/v2/rents/bulk-payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payments }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Upload failed');
      }

      // Handle failed records if any
      if (result.failedRecordsCsv) {
        const blob = new Blob([result.failedRecordsCsv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'failed_payments.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }

      toast.success(t('Bulk payments uploaded successfully'), {
        description: t('{{successful}} payments processed, {{failed}} failed', {
          successful: result.summary.successful,
          failed: result.summary.failed
        })
      });

      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message || t('An error occurred while uploading the file'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('Upload Bulk Payments')}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              onClick={downloadTemplate}
              className="w-full"
            >
              <LuDownload className="mr-2 h-4 w-4" />
              {t('Download Template')}
            </Button>
          </div>

          <div className="grid w-full items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="hidden"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              <LuUpload className="mr-2 h-4 w-4" />
              {file ? file.name : t('Select CSV File')}
            </Button>
          </div>

          {error && (
            <Alert variant="destructive">
              <LuAlertTriangle className="h-4 w-4" />
              <span>{error}</span>
            </Alert>
          )}

          <Button
            onClick={handleUpload}
            disabled={!file || loading}
            className="w-full"
          >
            {loading ? t('Uploading...') : t('Upload Payments')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
