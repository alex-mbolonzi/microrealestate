import * as React from 'react';
import { useRef, useState, useContext } from 'react';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { LuAlertTriangle, LuDownload, LuUpload } from 'react-icons/lu';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import { apiFetcher } from '../../utils/fetch';
import { StoreContext } from '../../store';
import config from '../../config';

const CHUNK_SIZE = 5; // Process 5 payments at a time

export default function BulkPaymentUpload({ isOpen, onClose, onSuccess }) {
  const { t } = useTranslation('common');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileInputRef = useRef(null);
  const store = useContext(StoreContext);

  const handleFileChange = (event) => {
    const selectedFile = event.target.files[0];
    if (selectedFile && selectedFile.type === 'text/csv') {
      setFile(selectedFile);
    } else {
      toast.error(t('Please select a valid CSV file'));
      event.target.value = null;
    }
  };

  const processPaymentsInChunks = async (payments, accessToken) => {
    const results = {
      successful: [],
      failed: [],
      failedRecordsCsv: null
    };

    // Process in chunks
    for (let i = 0; i < payments.length; i += CHUNK_SIZE) {
      const chunk = payments.slice(i, i + CHUNK_SIZE);
      try {
        const api = apiFetcher();
        const response = await api.post('/rents/upload', 
          { payments: chunk },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
            },
            timeout: 60000, // 1 minute timeout per chunk
          }
        );

        // Merge results
        results.successful = [...results.successful, ...(response.data.successful || [])];
        results.failed = [...results.failed, ...(response.data.failed || [])];
        if (response.data.failedRecordsCsv) {
          results.failedRecordsCsv = results.failedRecordsCsv || '';
          results.failedRecordsCsv += response.data.failedRecordsCsv;
        }

        // Update progress
        const newProgress = Math.min(((i + chunk.length) / payments.length) * 100, 100);
        setProgress(newProgress);
        
        // Show progress toast
        toast.info(
          t('Processing payments: {{processed}} of {{total}}', {
            processed: i + chunk.length,
            total: payments.length
          })
        );

      } catch (error) {
        console.error('Chunk processing error:', error);
        // Mark all payments in failed chunk as failed
        results.failed = [
          ...results.failed,
          ...chunk.map(payment => ({
            ...payment,
            error: error.message || 'Failed to process payment',
            status: 'failed'
          }))
        ];
      }

      // Small delay between chunks
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  };

  const ensureValidToken = async () => {
    let refreshResult;
    try {
      refreshResult = await store.user.refreshTokens();
      if (refreshResult.status !== 200 || !refreshResult.accessToken) {
        throw new Error('Token refresh failed: ' + (refreshResult.error?.message || 'Unknown error'));
      }
      console.log('Tokens refreshed successfully');
      return refreshResult.accessToken;
    } catch (refreshError) {
      console.error('Initial token refresh failed:', refreshError);
      toast.error(t('Authentication error. Please log in again.'));
      window.location.assign(`${config.BASE_PATH}`);
      return null;
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error(t('Please select a CSV file first'));
      return;
    }

    setLoading(true);
    setProgress(0);

    try {
      // Ensure we have a valid token before starting the upload
      const token = await ensureValidToken();
      if (!token) {
        throw new Error('Failed to get valid token');
      }

      // Read and parse CSV file
      const text = await file.text();
      const lines = text.split('\\n').filter(line => line.trim());
      const headers = lines[0].split(',');
      
      // Parse CSV into array of objects
      const payments = lines.slice(1).map(line => {
        const values = line.split(',');
        return headers.reduce((obj, header, index) => {
          obj[header.trim()] = values[index]?.trim() || '';
          return obj;
        }, {});
      }).filter(payment => payment.tenant_id && payment.payment_date && payment.amount);

      if (payments.length === 0) {
        throw new Error('No valid payments found in CSV');
      }

      console.log(`Processing ${payments.length} payments in chunks of ${CHUNK_SIZE}`);
      
      // Process payments in chunks
      const results = await processPaymentsInChunks(payments, token);

      // Handle results
      if (results.failed && results.failed.length > 0) {
        toast.error(t('Some payments failed to process. Check the error report.'));
        if (results.failedRecordsCsv) {
          const blob = new Blob([results.failedRecordsCsv], { type: 'text/csv' });
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'failed_payments.csv';
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
        }
      } else {
        toast.success(t('All payments processed successfully'));
      }

      // Show final summary
      toast.info(
        t('Upload Summary: {{successful}} successful, {{failed}} failed', {
          successful: results.successful.length,
          failed: results.failed.length
        })
      );

      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Upload error:', error);
      toast.error(error.message || t('Failed to upload file'));
    } finally {
      setLoading(false);
      setProgress(0);
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = null;
      }
    }
  };

  const handleDownloadTemplate = () => {
    const headers = ['tenant_id', 'payment_date', 'payment_type', 'payment_reference', 'amount'];
    const csvContent = headers.join(',');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bulk_payment_template.csv';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Upload Bulk Payments')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Alert variant="info" className="text-sm">
            <LuAlertTriangle className="h-4 w-4" />
            <div>
              <p>{t('Please ensure your CSV file follows the required format.')}</p>
              <p>{t('Download the template below for reference.')}</p>
            </div>
          </Alert>

          <div className="flex flex-col gap-4">
            <Button
              variant="outline"
              onClick={handleDownloadTemplate}
              className="w-full"
            >
              <LuDownload className="mr-2 h-4 w-4" />
              {t('Download Template')}
            </Button>

            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              ref={fileInputRef}
              className="hidden"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              <LuUpload className="mr-2 h-4 w-4" />
              {t('Select CSV File')}
            </Button>
            {file && (
              <p className="text-sm text-gray-500">
                {t('Selected file')}: {file.name}
              </p>
            )}

            {loading && progress > 0 && (
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className="bg-blue-600 h-2.5 rounded-full"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            )}

            <Button
              onClick={handleUpload}
              disabled={!file || loading}
              className="w-full"
            >
              {loading ? t('Uploading... {{progress}}%', { progress: Math.round(progress) }) : t('Upload Payments')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
